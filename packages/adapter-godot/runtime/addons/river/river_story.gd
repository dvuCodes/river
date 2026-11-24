class_name RiverStory
extends Resource

## Loaded River exported story (`stories/export/*.json`).

var schema_version: int = 1
var story_id: String = ""
var title: String = ""
var start_id: String = ""
var state_schema: Dictionary = {}
var passages: Dictionary = {}


static func load_from_file(path: String) -> RiverStory:
	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	if file == null:
		push_error("RiverStory: could not open '%s' (error %d)" % [path, FileAccess.get_open_error()])
		return null
	var text: String = file.get_as_text()
	file.close()
	var json: JSON = JSON.new()
	var err: Error = json.parse(text)
	if err != OK:
		push_error("RiverStory: JSON parse error in '%s' at line %d: %s" % [path, json.get_error_line(), json.get_error_message()])
		return null
	var parsed: Variant = json.data
	if not (parsed is Dictionary):
		push_error("RiverStory: root JSON value in '%s' must be an object" % path)
		return null
	return RiverStory.from_dict(parsed as Dictionary)


static func from_dict(data: Dictionary) -> RiverStory:
	var story: RiverStory = RiverStory.new()
	story.schema_version = int(data.get("schema", 1))
	story.story_id = str(data.get("id", ""))
	story.title = str(data.get("title", ""))
	story.start_id = str(data.get("start", ""))
	var raw_state: Variant = data.get("state", {})
	if raw_state is Dictionary:
		story.state_schema = (raw_state as Dictionary).duplicate(true)
	var raw_passages: Variant = data.get("passages", {})
	if raw_passages is Dictionary:
		story.passages = (raw_passages as Dictionary).duplicate(true)
	return story


func get_passage(id: String) -> Dictionary:
	if not passages.has(id):
		return {}
	var raw: Variant = passages[id]
	if raw is Dictionary:
		return raw as Dictionary
	return {}


func get_interrupts() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for pid_v: Variant in passages.keys():
		var pid: String = str(pid_v)
		var raw: Variant = passages[pid_v]
		if not (raw is Dictionary):
			continue
		var p: Dictionary = raw as Dictionary
		if is_interrupt_passage(p):
			var entry: Dictionary = p.duplicate(false)
			if not entry.has("id"):
				entry["id"] = pid
			result.append(entry)
	return result


## Passages tagged `storylet`, in story order, each with its "id".
func get_storylets() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for pid_v: Variant in passages.keys():
		var pid: String = str(pid_v)
		var raw: Variant = passages[pid_v]
		if not (raw is Dictionary):
			continue
		var p: Dictionary = raw as Dictionary
		if is_storylet_passage(p):
			var entry: Dictionary = p.duplicate(false)
			if not entry.has("id"):
				entry["id"] = pid
			result.append(entry)
	return result


func initial_state() -> Dictionary:
	var result: Dictionary = {}
	for var_name_v: Variant in state_schema.keys():
		var var_name: String = str(var_name_v)
		var decl_v: Variant = state_schema[var_name_v]
		if not (decl_v is Dictionary):
			continue
		var decl: Dictionary = decl_v as Dictionary
		var var_type: String = str(decl.get("type", ""))
		var has_initial: bool = decl.has("initial") and decl["initial"] != null
		match var_type:
			"int":
				if has_initial:
					result[var_name] = int(decl["initial"])
				elif decl.has("min") and decl["min"] != null:
					result[var_name] = int(decl["min"])
				else:
					result[var_name] = 0
			"number":
				if has_initial:
					result[var_name] = float(decl["initial"])
				elif decl.has("min") and decl["min"] != null:
					result[var_name] = float(decl["min"])
				else:
					result[var_name] = 0.0
			"bool":
				if has_initial:
					result[var_name] = bool(decl["initial"])
				else:
					result[var_name] = false
			"enum":
				if has_initial:
					result[var_name] = str(decl["initial"])
				else:
					var vals_v: Variant = decl.get("values", [])
					if vals_v is Array and (vals_v as Array).size() > 0:
						result[var_name] = str((vals_v as Array)[0])
					else:
						result[var_name] = ""
	return result


static func is_interrupt_passage(passage: Dictionary) -> bool:
	if passage.has("interrupt"):
		return bool(passage["interrupt"])
	var tags_v: Variant = passage.get("tags", [])
	if tags_v is Array:
		return (tags_v as Array).has("interrupt")
	return false


static func is_storylet_passage(passage: Dictionary) -> bool:
	if passage.has("storylet"):
		return bool(passage["storylet"])
	var tags_v: Variant = passage.get("tags", [])
	if tags_v is Array:
		return (tags_v as Array).has("storylet")
	return false
