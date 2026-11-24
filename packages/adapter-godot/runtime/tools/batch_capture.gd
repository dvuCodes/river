extends SceneTree
## Captures many River shots in one Godot process (one start-up instead of one per shot).
## Run: "$GODOT_BIN" --path <project> --disable-vsync -s <abs path>/batch_capture.gd -- --manifest=<abs path>.json
## The manifest is a JSON array of { "id", "scene", "setup" (may be ""), "outDir", "count", "ticks" (default 3) }.
## count 1 saves <outDir>/frame_00.png after 30 frames, like tools/capture.gd. count > 1 waits 10 frames after
## the setup script, then saves frame_00.png, frame_01.png ... with `ticks` hand-stepped 1/60 s ticks between
## them, like tools/capture_frames.gd. Each scene is freed before the next shot starts.
## Any load, setup or save error prints the shot id and exits with code 1.

const DT: float = 1.0 / 60.0
const SINGLE_WAIT_FRAMES: int = 30
const FRAMES_WAIT_FRAMES: int = 10

var _entries: Array[Dictionary] = []


func _initialize() -> void:
	var manifest_path: String = ""
	for arg: String in OS.get_cmdline_user_args():
		if arg.begins_with("--manifest="):
			manifest_path = arg.substr("--manifest=".length())
	if manifest_path.is_empty():
		push_error("batch_capture: --manifest=<path to JSON> is required")
		quit(1)
		return
	var text: String = FileAccess.get_file_as_string(manifest_path)
	if text.is_empty():
		push_error("batch_capture: cannot read manifest %s (error %d)" % [manifest_path, FileAccess.get_open_error()])
		quit(1)
		return
	var parsed: Variant = JSON.parse_string(text)
	if not (parsed is Array):
		push_error("batch_capture: manifest %s must be a JSON array of shots" % manifest_path)
		quit(1)
		return
	var items: Array = parsed
	for item: Variant in items:
		if not (item is Dictionary):
			push_error("batch_capture: every manifest entry must be an object")
			quit(1)
			return
		var entry: Dictionary = item
		_entries.append(entry)
	_run.call_deferred()


func _run() -> void:
	for entry: Dictionary in _entries:
		var ok: bool = await _capture(entry)
		if not ok:
			quit(1)
			return
	print("batch_capture: ok %d shots" % _entries.size())
	quit(0)


## One shot. Returns false after push_error on any failure.
func _capture(entry: Dictionary) -> bool:
	var id: String = str(entry.get("id", "?"))
	var scene_path: String = str(entry.get("scene", ""))
	var setup_path: String = str(entry.get("setup", ""))
	var out_dir: String = str(entry.get("outDir", ""))
	# JSON numbers arrive as floats.
	var count: int = int(str(entry.get("count", 1)).to_float())
	var ticks: int = int(str(entry.get("ticks", 3)).to_float())
	if scene_path.is_empty() or out_dir.is_empty() or count < 1:
		push_error("batch_capture: shot %s needs scene, outDir and a count of at least 1" % id)
		return false
	if not DirAccess.dir_exists_absolute(out_dir) and DirAccess.make_dir_recursive_absolute(out_dir) != OK:
		push_error("batch_capture: shot %s cannot create %s" % [id, out_dir])
		return false

	var packed: PackedScene = load(scene_path) as PackedScene
	if packed == null:
		push_error("batch_capture: shot %s cannot load scene %s" % [id, scene_path])
		return false
	var setup_script: GDScript = null
	if not setup_path.is_empty():
		setup_script = load(setup_path) as GDScript
		if setup_script == null or not setup_script.has_method("setup"):
			push_error("batch_capture: shot %s cannot load setup script %s (it needs a static func setup(scene))" % [id, setup_path])
			return false

	var scene: Node = packed.instantiate()
	root.add_child(scene)
	if setup_script != null:
		setup_script.call("setup", scene)

	var ok: bool = true
	if count == 1:
		for i: int in SINGLE_WAIT_FRAMES:
			await process_frame
		await RenderingServer.frame_post_draw
		ok = _save(id, "%s/frame_00.png" % out_dir)
	else:
		for i: int in FRAMES_WAIT_FRAMES:
			await process_frame
		for shot: int in count:
			await RenderingServer.frame_post_draw
			if not _save(id, "%s/frame_%02d.png" % [out_dir, shot]):
				ok = false
				break
			for tick: int in ticks:
				_step(scene)
			await process_frame

	scene.queue_free()
	await process_frame
	if ok:
		print("batch_capture: shot %s saved %d frame%s to %s" % [id, count, "" if count == 1 else "s", out_dir])
	return ok


func _save(id: String, path: String) -> bool:
	var image: Image = root.get_texture().get_image()
	var err: Error = image.save_png(path) if image != null else ERR_CANT_CREATE
	if err != OK:
		push_error("batch_capture: shot %s cannot save %s (%s)" % [id, path, error_string(err)])
		return false
	return true


func _step(node: Node) -> void:
	if node.get_script() != null:
		if node.has_method("_physics_process"):
			node.call("_physics_process", DT)
		if node.has_method("_process"):
			node.call("_process", DT)
	for child: Node in node.get_children():
		_step(child)
