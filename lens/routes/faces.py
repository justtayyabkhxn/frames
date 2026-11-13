"""Face listing and manual cluster assignment (people management lives in the client)."""

import asyncio

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel
from qdrant_client import models

from process.face_review import audit, suggest
from routes.common import require_ready
from routes.context import state

router = APIRouter()


class AssignRequest(BaseModel):
    """Move face points to a cluster; -1 rejects them from automatic clustering."""

    ids: list[str]
    cluster_id: int


@router.get("/v1/faces")
async def faces():
    """All faces without vectors, plus the version they were read at."""

    require_ready()

    version = state.store.faces.version
    items = [face async for face in state.store.faces.scroll_all()]

    return {"version": version, "faces": items}


@router.post("/v1/faces/assign")
async def assign(body: AssignRequest):
    """Assign faces to one cluster."""

    require_ready()

    await state.store.faces.assign_faces([(point_id, body.cluster_id) for point_id in body.ids])

    return {"assigned": len(body.ids)}


_matrix = {"version": None}


async def _faces_matrix():
    """All faces as (point ids, cluster ids with 0 = unassigned, L2-normed vectors); cached per faces version."""

    store = state.store.faces
    if _matrix["version"] == store.version:
        return _matrix["ids"], _matrix["clusters"], _matrix["vectors"]

    version = store.version
    filtr = models.Filter(must=[models.FieldCondition(key="fileid", range=models.Range(gte=1))])
    ids, clusters, vectors, offset = [], [], [], None
    while True:
        points, offset = await store.client.scroll(
            collection_name=store.collection,
            scroll_filter=filtr,
            offset=offset,
            limit=1000,
            with_payload=["cluster_id"],
            with_vectors=True,
        )
        for point in points:
            ids.append(str(point.id))
            clusters.append(int(point.payload.get("cluster_id") or 0))
            vectors.append(point.vector)
        if offset is None:
            break

    dim = store.dim or 1
    matrix = np.array(vectors, dtype=np.float32).reshape(len(vectors), -1 if vectors else dim)
    _matrix.update(version=version, ids=ids, clusters=np.array(clusters, dtype=np.int64), vectors=matrix)

    return ids, _matrix["clusters"], matrix


class SuggestRequest(BaseModel):
    """Unassigned faces that may be this person, minus ones the user already turned down."""

    cluster_id: int
    exclude: list[str] = []


@router.post("/v1/faces/suggestions")
async def suggestions(body: SuggestRequest):
    """Near-miss faces for one person, nearest first."""

    require_ready()
    ids, clusters, vectors = await _faces_matrix()
    skip = set(body.exclude)
    exclude = {i for i, pid in enumerate(ids) if pid in skip}
    hits = await asyncio.to_thread(suggest, vectors, clusters, body.cluster_id, exclude)

    return {"items": [{"id": ids[i], "distance": d} for i, d in hits]}


class AuditRequest(BaseModel):
    """Faces the user already confirmed where they are."""

    exclude: list[str] = []


@router.post("/v1/faces/audit")
async def audit_faces(body: AuditRequest):
    """Assigned faces that look misfiled, with the person they more likely belong to."""

    require_ready()
    ids, clusters, vectors = await _faces_matrix()
    flagged = await asyncio.to_thread(audit, vectors, clusters)
    skip = set(body.exclude)

    return {
        "faces": [
            {"id": ids[i], "cluster_id": int(clusters[i]), "suspected": q, "own": own, "other": other, "nearest": d}
            for i, q, own, other, d in flagged
            if ids[i] not in skip
        ],
    }
