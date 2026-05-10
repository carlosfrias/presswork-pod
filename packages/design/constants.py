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

OUTPUT_DPI = 300
OUTPUT_DIMENSIONS_PX = (4500, 5400)  # t-shirt print area at 300dpi (15"×18")
