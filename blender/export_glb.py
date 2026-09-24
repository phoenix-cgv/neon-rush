"""Exports a map .blend to the .glb the game loads.

Headless:  python3 export_glb.py <map>.blend ../assets/maps/<Map>.glb
In Blender: File > Export > glTF 2.0 (.glb) with the default settings does the same.

Default exporter settings, as the original map exports used: no lights or
cameras, modifiers not applied. The road ribbon must be smooth-shaded (or
perfectly flat) so each vertex is written once, keeping the across-road
vertex pairs that src/levels/glb-map.js reads as the centreline.
"""
import bpy
import sys

src, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=src)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB')
print("exported", out)
