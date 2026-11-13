"""Near-duplicate grouping over normalized image embeddings."""

import numpy as np

BLOCK = 2048


def group_duplicates(ids: list[int], vectors: np.ndarray, max_distance: float) -> list[list[int]]:
    """Groups (size >= 2) of ids whose cosine distance chains within max_distance; transitive like Gallery."""

    parent = list(range(len(ids)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    vectors = np.asarray(vectors, dtype=np.float32)
    vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12)
    min_sim = 1 - max_distance

    # ponytail: exact O(n^2) blocked matmul (~2 min CPU at 100k photos); swap for an ANN index if libraries grow past that
    for start in range(0, len(ids), BLOCK):
        sims = vectors[start : start + BLOCK] @ vectors[start:].T
        rows, cols = np.nonzero(sims >= min_sim)
        for r, c in zip(rows, cols):
            a, b = find(start + r), find(start + c)
            if a != b:
                parent[b] = a

    groups: dict[int, list[int]] = {}
    for i, fileid in enumerate(ids):
        groups.setdefault(find(i), []).append(fileid)

    return [sorted(g) for g in groups.values() if len(g) > 1]


if __name__ == "__main__":
    v = np.array([[1, 0, 0], [0.999, 0.04, 0], [0, 1, 0], [0, 0.9995, 0.03], [0, 0, 1]], dtype=np.float32)
    assert sorted(group_duplicates([1, 2, 3, 4, 5], v, 0.01)) == [[1, 2], [3, 4]]
    assert group_duplicates([1, 2, 3, 4, 5], v, 0.0001) == []
    print("ok")
