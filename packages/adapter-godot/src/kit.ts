import { createHash } from "node:crypto"

/**
 * Kit: River's drawing helpers for concept scripts, written into every concept sandbox as
 * res://kit.gd. It is part of River, reviewed here, so the user approves only the agent's script,
 * which calls Kit.ellipse(...) and the rest instead of carrying its own copies.
 */

export const KIT_GD = `class_name Kit
extends RefCounted

const _SAMPLES := [Vector2(0.25, 0.25), Vector2(0.75, 0.25), Vector2(0.25, 0.75), Vector2(0.75, 0.75)]
const _BAYER := [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const _CANOPY := [Vector3(0.0, -7.0, 2.6), Vector3(-1.9, -6.0, 1.9), Vector3(1.9, -6.2, 2.0), Vector3(0.7, -8.4, 1.8), Vector3(-1.0, -8.1, 1.7)]

## Random numbers from a seed: the same seed draws the same picture.
static func rng(seed: int) -> RandomNumberGenerator:
	var r := RandomNumberGenerator.new()
	r.seed = seed
	return r

## A transparent w x h image: a layer, or a small canvas for pixel art.
static func image(w: int, h: int) -> Image:
	return Image.create(w, h, false, Image.FORMAT_RGBA8)

## Blend c over one pixel. Every Kit call clips to the image and blends like this.
static func dot(img: Image, x: int, y: int, c: Color) -> void:
	if c.a <= 0.0 or x < 0 or y < 0 or x >= img.get_width() or y >= img.get_height():
		return
	img.set_pixel(x, y, img.get_pixel(x, y).blend(c))

## Filled rectangle.
static func rect(img: Image, r: Rect2i, c: Color) -> void:
	r = r.intersection(Rect2i(Vector2i.ZERO, img.get_size()))
	if c.a >= 1.0:
		img.fill_rect(r, c)
		return
	for y in range(r.position.y, r.end.y):
		for x in range(r.position.x, r.end.x):
			dot(img, x, y, c)

## Vertical gradient over r from top to bottom. steps > 0 gives that many flat bands.
static func vgradient(img: Image, r: Rect2i, top: Color, bottom: Color, steps := 0) -> void:
	for y in range(r.position.y, r.end.y):
		var t := float(y - r.position.y) / maxf(r.size.y - 1, 1)
		if steps > 0:
			t = minf(floorf(t * steps), steps - 1) / maxf(steps - 1, 1)
		rect(img, Rect2i(r.position.x, y, r.size.x, 1), top.lerp(bottom, t))

## Circular gradient, inner at center to outer at radius; beyond radius is untouched. Fade out with outer = Color(inner, 0).
static func radial(img: Image, center: Vector2, radius: float, inner: Color, outer: Color) -> void:
	for y in _span(center.y, radius, img.get_height()):
		for x in _span(center.x, radius, img.get_width()):
			var d := Vector2(x + 0.5, y + 0.5).distance_to(center)
			if d < radius:
				dot(img, x, y, inner.lerp(outer, d / radius))

## Additive light: c at full strength in the center, fading smoothly to nothing at radius.
static func glow(img: Image, center: Vector2, radius: float, c: Color) -> void:
	for y in _span(center.y, radius, img.get_height()):
		for x in _span(center.x, radius, img.get_width()):
			var d := Vector2(x + 0.5, y + 0.5).distance_to(center) / radius
			if d < 1.0:
				var f := (1.0 - d) * (1.0 - d) * c.a
				var p := img.get_pixel(x, y)
				img.set_pixel(x, y, Color(minf(p.r + c.r * f, 1.0), minf(p.g + c.g * f, 1.0), minf(p.b + c.b * f, 1.0), maxf(p.a, f)))

## Filled ellipse with soft edges; radii are half the width and half the height.
static func ellipse(img: Image, center: Vector2, radii: Vector2, c: Color) -> void:
	var rx := maxf(radii.x, 0.5)
	var ry := maxf(radii.y, 0.5)
	for y in _span(center.y, ry, img.get_height()):
		for x in _span(center.x, rx, img.get_width()):
			var d := Vector2((x + 0.5 - center.x) / rx, (y + 0.5 - center.y) / ry).length()
			var cover := clampf((1.0 - d) * minf(rx, ry) + 0.5, 0.0, 1.0)
			if cover > 0.0:
				dot(img, x, y, Color(c, c.a * cover))

## Filled circle with soft edges.
static func circle(img: Image, center: Vector2, radius: float, c: Color) -> void:
	ellipse(img, center, Vector2(radius, radius), c)

## Line from a to b, width pixels thick, with soft edges and round ends.
static func line(img: Image, a: Vector2, b: Vector2, width: float, c: Color) -> void:
	var half := maxf(width, 1.0) * 0.5
	var lo := a.min(b) - Vector2(half + 1.0, half + 1.0)
	var hi := a.max(b) + Vector2(half + 1.0, half + 1.0)
	for y in range(maxi(floori(lo.y), 0), mini(ceili(hi.y), img.get_height())):
		for x in range(maxi(floori(lo.x), 0), mini(ceili(hi.x), img.get_width())):
			var p := Vector2(x + 0.5, y + 0.5)
			var cover := clampf(half + 0.5 - p.distance_to(Geometry2D.get_closest_point_to_segment(p, a, b)), 0.0, 1.0)
			if cover > 0.0:
				dot(img, x, y, Color(c, c.a * cover))

## Filled polygon through points (an Array of Vector2), with soft edges.
static func polygon(img: Image, points: Array, c: Color) -> void:
	var poly := PackedVector2Array(points)
	var box := Rect2(poly[0], Vector2.ZERO)
	for p in poly:
		box = box.expand(p)
	for y in range(maxi(floori(box.position.y), 0), mini(ceili(box.end.y), img.get_height())):
		for x in range(maxi(floori(box.position.x), 0), mini(ceili(box.end.x), img.get_width())):
			var n := 0
			for s in _SAMPLES:
				if Geometry2D.is_point_in_polygon(Vector2(x, y) + s, poly):
					n += 1
			if n > 0:
				dot(img, x, y, Color(c, c.a * n / 4.0))

## Smooth value noise in 0..1. Scale x and y down (x * 0.05) for broad shapes; octaves add finer detail.
static func noise(x: float, y: float, seed := 0, octaves := 1) -> float:
	var total := 0.0
	var norm := 0.0
	var amp := 1.0
	for o in range(octaves):
		total += amp * _value(x, y, seed + o * 1013)
		norm += amp
		amp *= 0.5
		x *= 2.0
		y *= 2.0
	return total / norm

## Skyline of hills or treetops: fills from a noisy edge between y - height and y down to the bottom of the image.
static func ridge(img: Image, y: float, height: float, c: Color, seed := 0, scale := 0.02) -> void:
	for x in range(img.get_width()):
		var top := y - height * noise(x * scale, 0.0, seed, 3)
		rect(img, Rect2i(x, ceili(top), 1, img.get_height()), c)
		dot(img, x, floori(top), Color(c, c.a * (ceilf(top) - top)))

## count marks at random points in r: single pixels, or soft circles size pixels across when size > 1.
static func scatter(img: Image, r: Rect2i, count: int, c: Color, seed := 0, size := 1.0) -> void:
	var g := rng(seed)
	for i in range(count):
		var p := Vector2(g.randf_range(r.position.x, r.end.x), g.randf_range(r.position.y, r.end.y))
		if size <= 1.0:
			dot(img, floori(p.x), floori(p.y), c)
		else:
			circle(img, p, size * 0.5, c)

## Blend layer over img with the layer's top-left corner at at.
static func paste(img: Image, layer: Image, at := Vector2i.ZERO) -> void:
	img.blend_rect(layer, Rect2i(Vector2i.ZERO, layer.get_size()), at)

## Ring every shape on a layer with a 1-pixel outline of c, outside the shape.
static func outline(layer: Image, c: Color) -> void:
	var src := Image.create_from_data(layer.get_width(), layer.get_height(), false, layer.get_format(), layer.get_data())
	for y in range(layer.get_height()):
		for x in range(layer.get_width()):
			if src.get_pixel(x, y).a < 0.5 and _solid_beside(src, x, y):
				layer.set_pixel(x, y, c.blend(src.get_pixel(x, y)))

## Drop shadow on a layer: c under every shape, moved by offset. Call before paste.
static func shadow(layer: Image, c: Color, offset := Vector2i(2, 2)) -> void:
	var src := Image.create_from_data(layer.get_width(), layer.get_height(), false, layer.get_format(), layer.get_data())
	for y in range(layer.get_height()):
		for x in range(layer.get_width()):
			var q := Vector2i(x, y) - offset
			if q.x >= 0 and q.y >= 0 and q.x < src.get_width() and q.y < src.get_height():
				var a := src.get_pixel(q.x, q.y).a
				if a > 0.0:
					layer.set_pixel(x, y, Color(c, c.a * a).blend(src.get_pixel(x, y)))

## Sprite from text rows, one character per pixel, each scale x scale. Characters not in palette (such as ".") stay clear.
static func stamp(img: Image, rows: Array, palette: Dictionary, at: Vector2i, scale := 1) -> void:
	for j in range(rows.size()):
		var row := str(rows[j])
		for i in range(row.length()):
			if palette.has(row[i]):
				rect(img, Rect2i(at.x + i * scale, at.y + j * scale, scale, scale), Color(palette[row[i]]))

## Enlarge small to img's size with hard pixel edges and blend it over img.
static func upscale(img: Image, small: Image) -> void:
	var big := Image.create_from_data(small.get_width(), small.get_height(), false, small.get_format(), small.get_data())
	big.convert(img.get_format())
	big.resize(img.get_width(), img.get_height(), Image.INTERPOLATE_NEAREST)
	paste(img, big)

## Snap every pixel to the nearest palette color (Colors or "#rrggbb" strings). dither 0..1 trades bands for a 4x4 ordered pattern.
static func quantize(img: Image, palette: Array, dither := 0.0) -> void:
	var colors: Array[Color] = []
	for p in palette:
		colors.append(Color(p))
	for y in range(img.get_height()):
		for x in range(img.get_width()):
			var p := img.get_pixel(x, y)
			var off: float = ((_BAYER[(y % 4) * 4 + x % 4] + 0.5) / 16.0 - 0.5) * dither
			var want := Vector3(p.r + off, p.g + off, p.b + off)
			var best := colors[0]
			var best_d := INF
			for k in colors:
				var d := want.distance_squared_to(Vector3(k.r, k.g, k.b))
				if d < best_d:
					best_d = d
					best = k
			img.set_pixel(x, y, Color(best, p.a))

## Person standing with feet at feet, height pixels tall, in one flat color.
static func person(img: Image, feet: Vector2, height: float, c: Color) -> void:
	var u := height / 8.0
	circle(img, feet + Vector2(0.0, -7.3) * u, 0.68 * u, c)
	polygon(img, [feet + Vector2(-1.0, -6.4) * u, feet + Vector2(1.0, -6.4) * u, feet + Vector2(0.75, -3.4) * u, feet + Vector2(-0.75, -3.4) * u], c)
	for s in [-1.0, 1.0]:
		circle(img, feet + Vector2(0.62 * s, -6.1) * u, 0.42 * u, c)
		line(img, feet + Vector2(0.4 * s, -3.6) * u, feet + Vector2(0.5 * s, -0.3) * u, 0.75 * u, c)
		line(img, feet + Vector2(0.9 * s, -6.0) * u, feet + Vector2(1.35 * s, -3.6) * u, 0.45 * u, c)

## Dog in side view standing with feet at feet, height pixels to the top of its head. facing 1 looks right, -1 left.
static func dog(img: Image, feet: Vector2, height: float, c: Color, facing := 1.0) -> void:
	var u := height / 10.0
	var f := Vector2(facing, 1.0) * u
	ellipse(img, feet + Vector2(-0.2, -5.0) * f, Vector2(4.0, 2.1) * u, c)
	for x in [-3.2, -2.1, 1.9, 3.0]:
		line(img, feet + Vector2(x, -4.5) * f, feet + Vector2(x + 0.15, -0.6) * f, 1.2 * u, c)
	line(img, feet + Vector2(-3.8, -5.8) * f, feet + Vector2(-5.4, -7.4) * f, 0.8 * u, c)
	line(img, feet + Vector2(2.8, -5.6) * f, feet + Vector2(4.1, -7.8) * f, 2.2 * u, c)
	circle(img, feet + Vector2(4.4, -8.3) * f, 1.6 * u, c)
	ellipse(img, feet + Vector2(5.9, -7.8) * f, Vector2(1.4, 0.85) * u, c)
	line(img, feet + Vector2(3.9, -9.2) * f, feet + Vector2(3.2, -9.9) * f, 1.1 * u, c)

## Round-topped tree with its trunk base at base, height pixels tall, in one flat color.
static func tree(img: Image, base: Vector2, height: float, c: Color) -> void:
	var u := height / 10.0
	line(img, base, base + Vector2(0.0, -6.0) * u, 1.0 * u, c)
	for k in _CANOPY:
		circle(img, base + Vector2(k.x, k.y) * u, k.z * u, c)

static func _span(center: float, radius: float, limit: int) -> Array:
	return range(maxi(floori(center - radius) - 1, 0), mini(ceili(center + radius) + 1, limit))

static func _solid_beside(img: Image, x: int, y: int) -> bool:
	for d in [Vector2i(1, 0), Vector2i(-1, 0), Vector2i(0, 1), Vector2i(0, -1)]:
		var q: Vector2i = Vector2i(x, y) + d
		if q.x >= 0 and q.y >= 0 and q.x < img.get_width() and q.y < img.get_height() and img.get_pixel(q.x, q.y).a >= 0.5:
			return true
	return false

static func _value(x: float, y: float, seed: int) -> float:
	var ix := floori(x)
	var iy := floori(y)
	var fx := x - ix
	var fy := y - iy
	fx = fx * fx * (3.0 - 2.0 * fx)
	fy = fy * fy * (3.0 - 2.0 * fy)
	var top := lerpf(_hash(ix, iy, seed), _hash(ix + 1, iy, seed), fx)
	var bottom := lerpf(_hash(ix, iy + 1, seed), _hash(ix + 1, iy + 1, seed), fx)
	return lerpf(top, bottom, fy)

# Masked to 31 bits before each multiply so the product fits in 64 bits: the same seed gives the same noise everywhere.
static func _hash(x: int, y: int, seed: int) -> float:
	var h := (x * 374761393 + y * 668265263 + seed * 69069) & 0x7fffffff
	h = ((h ^ (h >> 13)) * 1274126177) & 0x7fffffff
	return float(h ^ (h >> 16)) / 2147483647.0
`

/**
 * Godot's editor writes this cache when it scans a project; the sandbox is never scanned, so
 * River writes it to make the name Kit resolve in the agent's script.
 */
export const KIT_CLASS_CACHE = `list=[{
"base": &"RefCounted",
"class": &"Kit",
"icon": "",
"is_abstract": false,
"is_tool": false,
"language": &"GDScript",
"path": "res://kit.gd"
}]
`

const PUBLIC_FUNC = /^static func ([a-z]\w*)\((.*)\)(?: -> (\w+))?:$/

/** The names of the Kit's public functions, read from KIT_GD: the only Kit.<name>( a concept script may write. */
export const KIT_FUNCTIONS: readonly string[] = KIT_GD.split("\n").flatMap((line) => {
  const name = PUBLIC_FUNC.exec(line)?.[1]
  return name ? [name] : []
})

/** The Kit's public functions as "Kit.name(args) -> type  # doc" lines, read from KIT_GD for the concept prompt. */
export const KIT_API: string = KIT_GD.split("\n")
  .flatMap((line, i, lines) => {
    const m = PUBLIC_FUNC.exec(line)
    if (!m) return []
    const ret = m[3] && m[3] !== "void" ? ` -> ${m[3]}` : ""
    const doc = lines[i - 1]?.startsWith("## ") ? `  # ${lines[i - 1]!.slice(3)}` : ""
    return [`Kit.${m[1]}(${m[2]})${ret}${doc}`]
  })
  .join("\n")

/** concepts/kit.gd: where an accepted concept's Kit lives in the game, so its scripts parse there too. */
export const KIT_FILE = "concepts/kit.gd"

const KIT_HEADER = "## River's drawing kit, used by accepted concept scripts. River replaces this file when the kit changes, unless you edit it."
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** The Kit as River writes it into a game: a header naming the hash of the rest, then the same bytes the sandbox runs. */
export function kitFileText(): string {
  return `${KIT_HEADER} sha256=${sha256(KIT_GD)}\n${KIT_GD}`
}

/**
 * What to do with the game's concepts/kit.gd: "write" when it is missing or is River's own copy of another
 * version (its header's hash still matches its body), "same" when it is this version, and "keep" when anyone
 * edited it or wrote their own: River never overwrites that.
 */
export function kitFileAction(existing: string | undefined): "write" | "same" | "keep" {
  if (existing === undefined) return "write"
  if (existing === kitFileText()) return "same"
  const header = /^## River's drawing kit[^\n]* sha256=([0-9a-f]{64})\n/.exec(existing)
  return header && sha256(existing.slice(header[0].length)) === header[1] ? "write" : "keep"
}
