"""Decode Planner's allowlisted raster formats from inherited private file handles."""

import io
import resource
import struct
import sys
import warnings

MAX_IMAGE_PIXELS = 24_000_000
MAX_TOTAL_PIXELS = 64_000_000
MAX_FRAMES = 32
FORMATS = {"JPEG", "PNG", "GIF", "WEBP", "migration-jpeg"}
OUTPUTS = ((4, 320), (5, 1024))


def limit_resources():
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024,) * 2)
    resource.setrlimit(resource.RLIMIT_CPU, (5, 6))


def count_pixels(image, total):
    pixels = image.width * image.height
    if not (0 < pixels <= MAX_IMAGE_PIXELS) or total + pixels > MAX_TOTAL_PIXELS:
        raise ValueError("Image exceeds pixel limits")
    return total + pixels


class JpegInterval(io.RawIOBase):
    """Keep the JPEG decoder inside the validated constituent's declared bytes."""

    def __init__(self, source, start, size):
        self.source = source
        self.start = start
        self.size = size
        self.position = 0

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self.position

    def seek(self, offset, whence=io.SEEK_SET):
        origin = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: self.size}[whence]
        if not 0 <= origin + offset <= self.size:
            raise ValueError("JPEG seek is outside its MP entry")
        self.position = origin + offset
        return self.position

    def readinto(self, buffer):
        limit = min(len(buffer), self.size - self.position)
        self.source.seek(self.start + self.position)
        count = self.source.readinto(memoryview(buffer)[:limit])
        self.position += count
        return count


def mpo_intervals(source, profile, offset):
    # MPF APP2 carries a TIFF directory. The offsets in secondary MP Entries
    # are relative to the TIFF byte order marker. The primary offset is zero.
    if len(profile) < 8 or profile[:4] not in {b"II*\0", b"MM\0*"}:
        raise ValueError("Invalid MP directory header")
    endian = "<" if profile[:2] == b"II" else ">"
    directory = struct.unpack_from(endian + "I", profile, 4)[0]
    if not 8 <= directory <= len(profile) - 6:
        raise ValueError("Invalid MP directory bounds")
    tag_count = struct.unpack_from(endian + "H", profile, directory)[0]
    directory_end = directory + 2 + tag_count * 12 + 4
    if directory_end > len(profile):
        raise ValueError("Incomplete MP directory")
    tags = {}
    for tag_offset in range(directory + 2, directory_end - 4, 12):
        tag, field_type, count, value = struct.unpack_from(endian + "HHII", profile, tag_offset)
        if tag in (0xB001, 0xB002):
            if tag in tags:
                raise ValueError("Duplicate MP index tag")
            tags[tag] = (field_type, count, value)
    image_type, value_count, images = tags.get(0xB001, (0, 0, 0))
    entry_type, entry_bytes, entry_offset = tags.get(0xB002, (0, 0, 0))
    if (image_type, value_count, entry_type) != (4, 1, 7) or not 1 <= images <= MAX_FRAMES:
        raise ValueError("Invalid MP image count or index type")
    if entry_bytes != images * 16 or entry_offset < directory_end or entry_offset + entry_bytes > len(profile):
        raise ValueError("Invalid MP entry inventory")
    source.seek(0, io.SEEK_END)
    file_size = source.tell()
    if not isinstance(offset, int) or not 0 < offset <= file_size - len(profile):
        raise ValueError("MP directory is outside the original")
    source.seek(offset)
    if source.read(len(profile)) != profile:
        raise ValueError("MP directory offset does not match the JPEG")
    intervals = []
    for index in range(images):
        attribute, size, relative = struct.unpack_from(endian + "III", profile, entry_offset + index * 16)
        if attribute & 0x07000000 or (relative == 0) != (index == 0):
            raise ValueError("Invalid MP JPEG entry")
        start = offset + relative if index else 0
        end = start + size
        if size < 4 or end > file_size or (index == 0 and end < offset + len(profile)):
            raise ValueError("MP JPEG is outside the original")
        source.seek(start)
        if source.read(3) != b"\xFF\xD8\xFF":
            raise ValueError("MP JPEG has no start marker")
        source.seek(end - 2)
        if source.read(2) != b"\xFF\xD9":
            raise ValueError("MP JPEG has no end marker")
        intervals.append((start, end))
    ordered = sorted(intervals)
    if any(left[1] > right[0] for left, right in zip(ordered, ordered[1:])):
        raise ValueError("Overlapping MP JPEG entries")
    return intervals


def migration_jpeg(source):
    from PIL import ImageOps, JpegImagePlugin

    with JpegImagePlugin.JpegImageFile(source) as primary:
        profile = primary.info.get("mp")
        if profile is None:
            count_pixels(primary, 0)
            primary.load()
            return ImageOps.exif_transpose(primary).convert("RGBA")
        if sum(name == "APP2" and data.startswith(b"MPF\0") for name, data in primary.applist) != 1:
            raise ValueError("Ambiguous MP directory")
        intervals = mpo_intervals(source, profile, primary.info.get("mpoffset"))
    total = 0
    # Open each JPEG directly. The MPO container decoder reuses the primary's dimensions.
    for start, end in intervals[1:] + intervals[:1]:
        with io.BufferedReader(JpegInterval(source, start, end - start)) as frame, JpegImagePlugin.JpegImageFile(frame) as image:
            total = count_pixels(image, total)
            image.load()
            if start == 0:
                return ImageOps.exif_transpose(image).convert("RGBA")
    raise ValueError("Missing primary MP image")


def ordinary_image(source, expected):
    from PIL import Image, ImageOps

    with Image.open(source, formats=[expected]) as image:
        if image.format != expected:
            raise ValueError("Unexpected image format")
        total = 0
        for frame in range(MAX_FRAMES + 1):
            try:
                image.seek(frame)
            except EOFError:
                break
            if frame == MAX_FRAMES:
                raise ValueError("Image exceeds frame limit")
            total = count_pixels(image, total)
            image.load()
        image.seek(0)
        return ImageOps.exif_transpose(image).convert("RGBA")


def derivatives(expected):
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    with open(3, "rb", closefd=False) as source:
        pixels = migration_jpeg(source) if expected == "migration-jpeg" else ordinary_image(source, expected)
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
    except (OSError, EOFError, ValueError, SyntaxError, MemoryError, Warning, struct.error, Image.DecompressionBombError):
        return 65
    return 0


if __name__ == "__main__":
    sys.exit(main())
