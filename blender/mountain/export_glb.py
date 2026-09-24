"""Exports the Mountain map to the .glb the game loads.

Headless:  python3 export_glb.py Mountain_3.blend ../../assets/maps/MountainTrack.glb
In Blender: File > Export > glTF 2.0 (.glb) with the default settings does the same.

Default exporter settings, as the previous MountainTrack.glb used: no lights or
cameras, modifiers not applied, flat-shaded (so the road ribbon comes out as
across-road vertex pairs, which src/levels/glb-map.js reads as the centreline).
"""
import bpy
import sys

src, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.open_mainfile(filepath=src)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB')
print("exported", out)
