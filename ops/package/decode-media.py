"""Decode Planner's allowlisted raster formats from inherited private file handles."""

import resource
import sys
import warnings

MAX_IMAGE_PIXELS = 24_000_000
MAX_TOTAL_PIXELS = 64_000_000
MAX_FRAMES = 32
FORMATS = {"JPEG", "PNG", "GIF", "WEBP"}
OUTPUTS = ((4, 320), (5, 1024))


def limit_resources():
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (5, 6))


def derivatives(expected):
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    with open(3, "rb", closefd=False) as source, Image.open(source, formats=[expected]) as image:
        if image.format != expected:
            raise ValueError("Unexpected image format")
        total_pixels = 0
        for frame in range(MAX_FRAMES + 1):
            try:
                image.seek(frame)
            except EOFError:
                break
            pixels = image.width * image.height
            total_pixels += pixels
            if frame == MAX_FRAMES or not (0 < pixels <= MAX_IMAGE_PIXELS) or total_pixels > MAX_TOTAL_PIXELS:
                raise ValueError("Image exceeds frame or pixel limits")
            image.load()
        image.seek(0)
        pixels = ImageOps.exif_transpose(image).convert("RGBA")
        pixels.info.clear()
        for fd, bound in OUTPUTS:
            variant = pixels.copy()
            variant.thumbnail((bound, bound), Image.Resampling.LANCZOS)
            with open(fd, "wb", closefd=False) as destination:
                variant.save(destination, format="PNG", compress_level=6)


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in FORMATS:
        return 64
    limit_resources()
    from PIL import Image

    try:
        derivatives(sys.argv[1])
    except (OSError, EOFError, ValueError, SyntaxError, MemoryError, Warning, Image.DecompressionBombError):
        return 65
    return 0


if __name__ == "__main__":
    sys.exit(main())
