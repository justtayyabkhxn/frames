"""Memories Lens daemon: index API, search API, health/stats."""

import asyncio
import logging
import os
import sys
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from qdrant_client import AsyncQdrantClient

from config import config
from index import Indexer, IndexQueue, Scanner
from routes import routers
from routes.context import embedding_model, face_model, schema_model, sentence_model, state
from store import Store


def exit_with_parent():
    """Local mode: the parent app holds our stdin; exit once it closes (parent quit or crashed)."""

    sys.stdin.read()
    os._exit(0)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load models and collections, then start jobs; initialization failures are fatal."""

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s: %(message)s",
    )

    await asyncio.to_thread(embedding_model.ensure_snapshot)
    await asyncio.to_thread(embedding_model.load)
    await asyncio.to_thread(sentence_model.ensure_snapshot)
    await asyncio.to_thread(sentence_model.load)
    await asyncio.to_thread(schema_model.ensure_snapshot)
    await asyncio.to_thread(schema_model.load)
    await asyncio.to_thread(face_model.ensure_snapshot)
    await asyncio.to_thread(face_model.load)

    if config.local:
        threading.Thread(target=exit_with_parent, daemon=True).start()

    if config.qdrant_path:
        client = AsyncQdrantClient(path=config.qdrant_path)
    else:
        client = AsyncQdrantClient(url=config.qdrant_url)
    store = Store(
        client=client,
        embedding_dim=embedding_model.dim(),
        sentence_dim=sentence_model.dim(),
        face_dim=face_model.dim(),
    )
    state.store = store

    index_queue = IndexQueue(maxsize=config.queue_max)
    state.index_queue = index_queue
    indexer = Indexer(
        embedding_model=embedding_model,
        sentence_model=sentence_model,
        store=store,
        done=index_queue.done,
        face_model=face_model if config.local else None,
    )
    scanner = Scanner(store, index_queue)
    state.scanner = scanner

    tasks = []
    try:
        for collection in store.collections:
            await collection.ensure_collection()

        state.qdrant = "ok"
        state.ready = True
        tasks = [index_queue.run(indexer.handle_batch), asyncio.create_task(scanner.run())]

        yield
    finally:
        state.ready = False
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await client.close()


app = FastAPI(title="Memories Lens", lifespan=lifespan)

for router in routers:
    app.include_router(router)
