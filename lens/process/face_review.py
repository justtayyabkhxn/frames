"""Face review math (Gallery's rules): suggestions for a person, and faces likely filed under the wrong person."""

import numpy as np

BLOCK = 2048


def suggest(vectors, clusters, person, exclude, samples=20, min_distance=0.5, max_distance=0.7):
    """Unassigned faces in (min_distance, max_distance] of any of the person's first `samples` faces; [(index, distance)]."""

    own = np.nonzero(clusters == person)[0][:samples]
    free = np.nonzero(clusters == 0)[0]
    free = free[~np.isin(free, list(exclude))] if exclude else free

    if not own.size or not free.size:
        return []

    dist = 1 - (vectors[free] @ vectors[own].T).max(axis=1)
    keep = (dist > min_distance) & (dist <= max_distance)

    return sorted(zip(free[keep].tolist(), dist[keep].tolist()), key=lambda x: x[1])


def audit(vectors, clusters, max_distance=0.5, attribution=0.35, min_faces=3, margin=2, window=200):
    """Assigned faces whose neighbours mostly belong to another confident person; [(index, suspected, own, other, nearest)]."""

    assigned = np.nonzero(clusters > 0)[0]
    vecs, owner = vectors[assigned], clusters[assigned]
    flagged = []

    for start in range(0, len(assigned), BLOCK):
        sims = vecs[start : start + BLOCK] @ vecs.T
        for r in range(sims.shape[0]):
            i = start + r
            row = sims[r]
            row[i] = -1
            near = np.nonzero(row >= 1 - max_distance)[0]
            if near.size > window:
                near = near[np.argpartition(-row[near], window)[:window]]
            own = int((owner[near] == owner[i]).sum())
            tally = {}
            for j in near[owner[near] != owner[i]]:
                count, best = tally.get(owner[j], (0, 2.0))
                tally[owner[j]] = (count + 1, min(best, 1 - float(row[j])))
            if not tally:
                continue
            q, (count, nearest) = min(tally.items(), key=lambda kv: (-kv[1][0], kv[1][1], kv[0]))
            confident = count >= min_faces and nearest <= attribution
            if confident and (count - own >= margin or own < min_faces):
                flagged.append((int(assigned[i]), int(q), own, count, nearest))

    return flagged


if __name__ == "__main__":
    rng = np.random.default_rng(0)
    a, b = rng.normal(size=512), rng.normal(size=512)
    jitter = lambda base, n: [base + rng.normal(scale=0.2, size=512) for _ in range(n)]
    vectors = np.array(jitter(a, 5) + jitter(b, 5) + jitter(b, 1) + jitter(a, 1) + [rng.normal(size=512)])
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    # five of A in 1, five of B in 2, one B misfiled under 1, one free A, one free stranger
    clusters = np.array([1] * 5 + [2] * 5 + [1] + [0] + [0])
    flagged = audit(vectors, clusters)
    assert [(f[0], f[1]) for f in flagged] == [(10, 2)], flagged
    hits = suggest(vectors, clusters, 1, set(), min_distance=0.0)
    assert [h[0] for h in hits] == [11], hits
    assert suggest(vectors, clusters, 1, {11}, min_distance=0.0) == []
    print("ok")
