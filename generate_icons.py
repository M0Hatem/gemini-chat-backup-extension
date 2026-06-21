import os
import zlib
import struct

def make_png(width, height, get_color_fn):
    # PNG signature
    png = b'\x89PNG\r\n\x1a\n'
    
    # IHDR chunk: width (4 bytes), height (4 bytes), bit depth (1 byte, 8), color type (1 byte, 6 for RGBA), compression method (1 byte, 0), filter method (1 byte, 0), interlace method (1 byte, 0)
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    png += struct.pack('>I', 13) + b'IHDR' + ihdr_data + struct.pack('>I', zlib.crc32(b'IHDR' + ihdr_data))
    
    # IDAT chunk
    # Each row starts with a filter byte (0 for None filter) followed by width * 4 bytes of RGBA pixels
    img_data = bytearray()
    for y in range(height):
        img_data.append(0) # Filter type 0
        for x in range(width):
            color = get_color_fn(x, y, width)
            img_data.extend(color)
            
    compressed = zlib.compress(img_data)
    png += struct.pack('>I', len(compressed)) + b'IDAT' + compressed + struct.pack('>I', zlib.crc32(b'IDAT' + compressed))
    
    # IEND chunk
    png += struct.pack('>I', 0) + b'IEND' + struct.pack('>I', zlib.crc32(b'IEND'))
    return png

def get_icon_color(x, y, size):
    # Center of image
    cx, cy = size / 2.0, size / 2.0
    
    # Distance from center
    dx = x - cx
    dy = y - cy
    dist = (dx*dx + dy*dy)**0.5
    
    outer_r = size * 0.45
    inner_r = size * 0.22
    
    # 1. Circle Background (dodgerblue to royalblue gradient)
    if dist <= outer_r:
        # 2. Inner Chat Bubble Shape (white)
        # Let's shift the bubble slightly up and right
        bx = x - (cx - size * 0.02)
        by = y - (cy - size * 0.02)
        b_dist = (bx*bx + by*by)**0.5
        
        # Check if inside bubble body
        if b_dist <= inner_r:
            # Small green/blue center sync indicator dot inside the bubble
            dot_x = x - (cx - size * 0.02)
            dot_y = y - (cy - size * 0.02)
            dot_dist = (dot_x*dot_x + dot_y*dot_y)**0.5
            if dot_dist <= (size * 0.07):
                return (66, 133, 244, 255) # Google Blue
            return (255, 255, 255, 255) # Bubble Body (White)
            
        # Draw tail for bubble (triangle at bottom-left)
        # Tail vertices roughly: (cx - size*0.2, cy), (cx, cy + size*0.2), (cx - size*0.22, cy + size*0.22)
        # We check if pixel falls inside the tail triangle
        # Vertex 1: (cx - size * 0.22, cy)
        # Vertex 2: (cx, cy + size * 0.22)
        # Vertex 3: (cx - size * 0.22, cy + size * 0.22)
        tx = x - cx
        ty = y - cy
        if tx < 0 and ty > 0 and (tx - ty) >= -size * 0.35 and tx >= -size * 0.22 and ty <= size * 0.22:
            return (255, 255, 255, 255) # Tail (White)
            
        # Circle Gradient (DodgerBlue primary to darker RoyalBlue)
        ratio = (x + y) / (2.0 * size)
        r = int(30 + (30 - 30) * ratio)
        g = int(144 - (144 - 100) * ratio)
        b = int(255 - (255 - 200) * ratio)
        return (r, g, b, 255)
    else:
        # Transparent padding
        return (0, 0, 0, 0)

def main():
    sizes = [16, 48, 128]
    output_dir = "gemini-chat-backup-extension"
    os.makedirs(output_dir, exist_ok=True)
    
    for size in sizes:
        png_data = make_png(size, size, get_icon_color)
        filepath = os.path.join(output_dir, f"icon{size}.png")
        with open(filepath, "wb") as f:
            f.write(png_data)
        print(f"Generated {filepath}")

if __name__ == "__main__":
    main()
