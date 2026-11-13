"""Face indexing: detect, embed, store and incrementally cluster the faces of one image."""

import logging
import secrets
from collections import Counter

import cv2
import numpy as np

from config import config
from store import FacePoint, face_point_id

log = logging.getLogger("lens.faces")

# Faces smaller than this (in decoded pixels) embed poorly and only add noise to clusters.
MIN_FACE_PX = 32
NEIGHBORS = 20
# Payload marker for faces the user removed from a person; never auto-clustered again.
REJECTED = -1


def faces_stale(payload: dict) -> bool:
    """True when an image point was not yet face-scanned by the current face model (local mode only)."""

    return config.local and payload.get("face_version") != config.face.version


def new_cluster_id() -> int:
    """Random positive id below 2**53 so JavaScript clients keep it exact."""

    return secrets.randbelow(2**53 - 2) + 1


def pick_cluster(hits: list[dict], point_id: str) -> tuple[int | None, list[str]]:
    """
    Cluster for a new face from its nearest neighbors.

    Join the majority cluster among neighbors within FACE_MAX_DISTANCE; otherwise,
    when enough unclustered neighbors form a dense core (FACE_MIN_FACES), start a
    new cluster with them. Returns (cluster_id or None, other point ids to move).
    """

    near = [h for h in hits if h["id"] != point_id and 1 - h["score"] <= config.face.max_distance]
    clustered = [h["cluster_id"] for h in near if h.get("cluster_id", 0) > 0]

    if clustered:
        return Counter(clustered).most_common(1)[0][0], []

    free = [h["id"] for h in near if "cluster_id" not in h]

    if len(free) + 1 >= config.face.min_faces:
        return new_cluster_id(), free

    return None, []


async def index_faces(face_model, store, fileid, parent_id, metadata, image) -> int:
    """Replace one file's faces and cluster them; returns the number of faces kept."""

    bgr = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
    faces = await face_model.detect_async(bgr)
    faces = [f for f in faces if min(f["w"] * image.width, f["h"] * image.height) >= MIN_FACE_PX]
    vectors = await face_model.embed_async(bgr, faces) if faces else []

    points = [
        FacePoint(
            fileid=fileid,
            parent_id=parent_id,
            owner_id=config.nc_user,
            face_idx=idx,
            vector=vector,
            x=face["x"],
            y=face["y"],
            w=face["w"],
            h=face["h"],
            det_score=face["det_score"],
            mtime=metadata.mtime,
            etag=metadata.etag,
        )
        for idx, (face, vector) in enumerate(zip(faces, vectors))
    ]
    await store.faces.replace_many([fileid], points)

    for point in points:
        point_id = face_point_id(point.fileid, point.face_idx)
        hits = await store.faces.search_owner(point.vector, config.nc_user, NEIGHBORS)
        cluster_id, others = pick_cluster(hits, point_id)

        if cluster_id is not None:
            await store.faces.assign_faces([(pid, cluster_id) for pid in [point_id, *others]])

    return len(points)


if __name__ == "__main__":
    near, far = 1 - config.face.max_distance / 2, 1 - config.face.max_distance * 2
    assert pick_cluster([{"id": "a", "score": 1.0}], "a") == (None, [])
    assert pick_cluster([{"id": "b", "score": near, "cluster_id": 7}, {"id": "c", "score": far}], "a") == (7, [])
    assert pick_cluster([{"id": "b", "score": near, "cluster_id": REJECTED}], "a") == (None, [])
    cid, others = pick_cluster([{"id": str(i), "score": near} for i in range(config.face.min_faces - 1)], "a")
    assert 0 < cid < 2**53 and len(others) == config.face.min_faces - 1
    print("ok")
