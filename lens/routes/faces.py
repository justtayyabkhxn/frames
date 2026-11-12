"""Face listing and manual cluster assignment (people management lives in the client)."""

from fastapi import APIRouter
from pydantic import BaseModel

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
