STORAGE_BUCKET = "designs"

# Blueprint and variant IDs for Gildan 64000 Softstyle Unisex T-Shirt.
# Source: GET https://api.printify.com/v1/catalog/blueprints.json (blueprint 145 = "Unisex Softstyle T-Shirt")
# These declare the intended product on each design_packages row; the Listing Agent
# uses them when creating the Printify product (which also yields the mockup images).
GILDAN_64000_BLUEPRINT_ID: int = 145

# Print provider that owns the variant IDs below. Printify variant IDs are scoped
# to a (blueprint_id, print_provider_id) pair — variant 38163 only resolves under
# print_provider_id=3 (Marco Fine Arts) for blueprint 145. The Listing Agent
# passes this value into the create-product call alongside blueprint_id; mismatched
# pairs are rejected by Printify's API.
GILDAN_64000_PRINT_PROVIDER_ID: int = 3

# White t-shirt, sizes S / M / L / XL / 2XL
GILDAN_64000_VARIANT_IDS: list[int] = [38163, 38177, 38191, 38205, 38219]

FLUX_MODEL = "fal-ai/flux-pro/v1.1"
FLUX_IMAGE_SIZE = "square_hd"  # 1024×1024

# aura-sr is a feed-forward (GAN-style) 4× upscaler. Deterministic, ~3-6s,
# preserves graphic-style lines without diffusion drift. Fed the raw FLUX RGB
# output BEFORE rembg/whitespace stripping so it sees clean pixels.
UPSCALER_MODEL = "fal-ai/aura-sr"
UPSCALER_SCALE = 4

OUTPUT_DPI = 300
OUTPUT_DIMENSIONS_PX = (4500, 5400)  # t-shirt print area at 300dpi (15"×18")

# Endpoints of the linear alpha ramp used when stripping interior whitespace
# from screen-print designs. Pixels with luminance >= WHITE_HARD become fully
# transparent; pixels with luminance <= WHITE_SOFT keep their original alpha;
# in between, alpha is multiplied by a linear factor in [0.0, 1.0]. The soft
# edge preserves the anti-aliasing rembg produces on curved boundaries, so
# letterforms and silhouettes don't show stair-stepping after threshold.
#
# These thresholds are tuned for FLUX outputs, where the background sits at
# ~250 and ink at ~10. JPG sources with compression ringing or pre-existing
# midtone shading don't dial in well at these values — the screen_print path
# is a known-rough opt-in mode; see notes in image_processor.py.
SCREEN_PRINT_WHITE_HARD = 245
SCREEN_PRINT_WHITE_SOFT = 225
