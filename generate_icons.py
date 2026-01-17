from PIL import Image
import os
import sys

# Constants
SOURCE_IMAGE_PATH = "/Users/iefan/.gemini/antigravity/brain/d05571b1-36de-405d-87b1-d8399537abc7/uploaded_image_0_1768688588274.png"
OUTPUT_DIR = "/Users/iefan/code/local-llm-1/public"
SIZES = [
    (192, 192, "pwa-192x192.png"),
    (512, 512, "pwa-512x512.png"),
    (180, 180, "apple-touch-icon.png")
    # (64, 64, "favicon.ico") # Optional, handling PNGs first
]

def generate_icons():
    # Ensure output directory exists
    if not os.path.exists(OUTPUT_DIR):
        print(f"Directory {OUTPUT_DIR} does not exist.")
        return

    try:
        # Open source image
        with Image.open(SOURCE_IMAGE_PATH) as img:
            # Convert to RGBA just in case
            if img.mode != 'RGBA':
                img = img.convert('RGBA')

            print(f"Loaded image: {SOURCE_IMAGE_PATH}")

            for width, height, filename in SIZES:
                # Resize with high quality resampling
                resized_img = img.resize((width, height), Image.Resampling.LANCZOS)
                
                output_path = os.path.join(OUTPUT_DIR, filename)
                resized_img.save(output_path, "PNG")
                print(f"Generated: {output_path}")

            # Generate favicon (64x64 or 32x32?)
            # Let's check requirements. Standard vite template uses favicon.svg usually.
            # But we can generate a simple favicon.ico if needed.
            # user didn't explicitly ask for .ico but it's good practice.
            # Let's assume vite handles favicon.ico if present.
            
    except Exception as e:
        print(f"Error processing image: {e}")
        sys.exit(1)

if __name__ == "__main__":
    generate_icons()
