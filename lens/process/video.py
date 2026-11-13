"""Video search: Frames sends sampled frames stacked vertically in one JPEG; embed each and average."""

import numpy as np

FRAMES = 4


def split_frames(image, frames: int = FRAMES):
    """Cut a vertical strip of equal-height frames back into separate images."""

    h = image.height // frames
    return [image.crop((0, i * h, image.width, (i + 1) * h)) for i in range(frames)] if h else [image]


def mean_vectors(groups: list[int], vectors: list[list[float]]) -> list[list[float]]:
    """Average consecutive runs of vectors (sizes in `groups`) and re-normalize each mean."""

    out, start = [], 0
    for size in groups:
        mean = np.mean(np.asarray(vectors[start : start + size], dtype=np.float64), axis=0)
        out.append((mean / (np.linalg.norm(mean) or 1)).tolist())
        start += size
    return out


if __name__ == "__main__":
    from PIL import Image

    strip = Image.new("RGB", (64, 4 * 36))
    assert [f.size for f in split_frames(strip)] == [(64, 36)] * 4
    assert mean_vectors([1, 2], [[1, 0], [1, 0], [0, 1]]) == [[1.0, 0.0], [0.7071067811865475, 0.7071067811865475]]
    print("ok")
