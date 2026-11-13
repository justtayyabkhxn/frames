"""Near-duplicate photo groups from the image embeddings."""

import asyncio

import numpy as np
from fastapi import APIRouter, Query
from qdrant_client import models

from process.duplicates import group_duplicates
from routes.common import require_ready
from routes.context import state
from store import FAILURE_KIND

router = APIRouter()


@router.get("/v1/duplicates")
async def duplicates(max_distance: float = Query(0.03, gt=0, le=0.2)):
    """Groups of fileids whose image embeddings are within max_distance (cosine)."""

    require_ready()

    store = state.store.embedding
    filtr = models.Filter(
        must=[models.FieldCondition(key="fileid", range=models.Range(gte=1))],
        must_not=[models.FieldCondition(key="kind", match=models.MatchValue(value=FAILURE_KIND))],
    )
    ids, vectors, offset = [], [], None

    while True:
        points, offset = await store.client.scroll(
            collection_name=store.collection,
            scroll_filter=filtr,
            offset=offset,
            limit=1000,
            with_payload=["fileid"],
            with_vectors=True,
        )
        for point in points:
            ids.append(int(point.payload["fileid"]))
            vectors.append(point.vector)
        if offset is None:
            break

    if not ids:
        return {"groups": []}

    groups = await asyncio.to_thread(group_duplicates, ids, np.array(vectors), max_distance)

    return {"groups": groups}
