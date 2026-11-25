"""Write an independently generated MPO with different JPEG frame dimensions."""

import sys

from PIL import Image

with Image.new('RGB', (500, 240), '#876356') as first, Image.new('RGB', (24, 650), '#357819') as second:
    first.save(sys.argv[1], 'MPO', save_all=True, append_images=[second])
