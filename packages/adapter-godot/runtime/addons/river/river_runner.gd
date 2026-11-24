class_name RiverRunner
extends RefCounted

## Runtime executor for RiverStory with semantic parity to @river/core.

signal passage_entered(passage_id: String, passage: Dictionary)
signal choice_taken(passage_id: String, choice_index: int, choice: Dictionary)
signal cue_triggered(name: String, args: String)
signal state_changed(variable: String, old_value: Variant, new_value: Variant)
signal story_ended(passage_id: String, ending: bool)
signal storylet_drawn(passage_id: String)

const RETURN_TARGET: String = "@return"

var _story: RiverStory = null
var _history: Array[Dictionary] = []


func start(story: RiverStory, from_id: String = "", state_override: Dictionary = {}) -> void:
	_story = story
	_history.clear()
	if _story == null:
		push_error("RiverRunner.start: story is null")
		return
	var start_pid: String = from_id if from_id != "" else _story.start_id
	if not _story.passages.has(start_pid):
		push_error("RiverRunner.start: passage '%s' does not exist" % start_pid)
		return

	var base_state: Dictionary = _story.initial_state()
	for k_v: Variant in state_override.keys():
		var k: String = str(k_v)
		base_state[k] = _settle_var_value(k, state_override[k_v])

	var passage: Dictionary = _story.get_passage(start_pid)
	var on_enter_v: Variant = passage.get("onEnter", [])
	var on_enter: Array = on_enter_v as Array if on_enter_v is Array else []
	var entered_state: Dictionary = apply_effects(base_state, on_enter)
	var visits: Dictionary = { start_pid: 1 }

	_history.append({
		"passage_id": start_pid,
		"state": entered_state.duplicate(true),
		"visits": visits,
		"used_once": {},
		"return_to": "",
		"turn": 0,
		"cooldowns": {},
	})

	_emit_state_diffs(base_state, entered_state)
	passage_entered.emit(start_pid, passage)
	_emit_cues(passage.get("cues", []))
	if is_over():
		story_ended.emit(start_pid, bool(passage.get("ending", false)))


func current_id() -> String:
	if _history.is_empty():
		return ""
	return str(_top()["passage_id"])


func current_passage() -> Dictionary:
	if _story == null or _history.is_empty():
		return {}
	return _story.get_passage(current_id())


func get_state() -> Dictionary:
	if _history.is_empty():
		return {}
	return (_top()["state"] as Dictionary).duplicate(true)


func set_var(name: String, value: Variant) -> void:
	if _story == null or _history.is_empty():
		push_error("RiverRunner.set_var: runner has not been started")
		return
	var top: Dictionary = _top()
	var st: Dictionary = top["state"] as Dictionary
	var old_value: Variant = st.get(name, null)
	var settled: Variant = _settle_var_value(name, value)
	st[name] = settled
	if not _values_equal(old_value, settled):
		state_changed.emit(name, old_value, settled)


func get_visits() -> Dictionary:
	if _history.is_empty():
		return {}
	return (_top()["visits"] as Dictionary).duplicate(true)


## Turns taken: 0 at the start, one more for each choose() and each draw_storylet(). An interrupt keeps the turn it started on.
func get_turn() -> int:
	return _current_turn()


## Storylet passage id -> the turn its @cooldown ends on. It can be drawn again once the turn reaches it.
func get_cooldowns() -> Dictionary:
	return _current_cooldowns().duplicate(true)


func is_over() -> bool:
	if _story == null or _history.is_empty():
		return false
	var passage: Dictionary = current_passage()
	if bool(passage.get("ending", false)):
		return true
	var entries: Array[Dictionary] = get_choices()
	for entry: Dictionary in entries:
		if bool(entry.get("open", false)):
			return false
	return true


func can_undo() -> bool:
	return _history.size() > 1


func undo() -> bool:
	if _history.size() <= 1:
		return false
	var prev_state: Dictionary = (_top()["state"] as Dictionary).duplicate(true)
	_history.pop_back()
	var next_state: Dictionary = _current_state()
	_emit_state_diffs(prev_state, next_state)
	passage_entered.emit(current_id(), current_passage())
	return true


func eval_cond(cond: Dictionary, state_dict: Dictionary = {}, visits_dict: Dictionary = {}) -> bool:
	if cond.is_empty():
		return true
	var st: Dictionary = state_dict if not state_dict.is_empty() else _current_state()
	var vis: Dictionary = visits_dict if not visits_dict.is_empty() else _current_visits()
	return _eval_cond_internal(cond, st, vis)


func apply_effects(state_dict: Dictionary, effects: Array) -> Dictionary:
	var next: Dictionary = state_dict.duplicate(true)
	for eff_v: Variant in effects:
		if not (eff_v is Dictionary):
			continue
		var eff: Dictionary = eff_v as Dictionary
		var var_name: String = str(eff.get("variable", ""))
		var op: String = str(eff.get("op", ""))
		var amount: Variant = eff.get("amount")
		var cur: Variant = next.get(var_name, null)
		var cur_num: float = float(cur) if (cur is int or cur is float) else 0.0
		var amt_num: float = float(amount) if (amount is int or amount is float) else 0.0
		var result_val: Variant = amount
		match op:
			"add":
				result_val = cur_num + amt_num
			"mul":
				result_val = cur_num * amt_num
			"set":
				result_val = amount
			_:
				continue
		if result_val is int or result_val is float:
			next[var_name] = _settle_number(float(result_val), _var_decl(var_name))
		else:
			next[var_name] = result_val
	return next


func get_choices() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	if _story == null or _history.is_empty():
		return result
	var pid: String = current_id()
	var passage: Dictionary = current_passage()
	var choices_v: Variant = passage.get("choices", [])
	if not (choices_v is Array):
		return result
	var choices_arr: Array = choices_v as Array
	var st: Dictionary = _current_state()
	var vis: Dictionary = _current_visits()
	var used_once: Dictionary = _current_used_once()
	var ret_to: String = _current_return_to()

	for i: int in range(choices_arr.size()):
		var c_v: Variant = choices_arr[i]
		if not (c_v is Dictionary):
			continue
		var choice: Dictionary = c_v as Dictionary
		var closed_by: String = ""
		var closed_reason: String = ""

		# 1. @once check
		if bool(choice.get("once", false)) and used_once.has(_once_key(pid, i)):
			closed_by = "once"
			closed_reason = "already used"

		# 2. choice @when check
		if closed_by == "":
			var c_when_v: Variant = choice.get("when", null)
			if c_when_v is Dictionary and not (c_when_v as Dictionary).is_empty():
				var c_when: Dictionary = c_when_v as Dictionary
				if not _eval_cond_internal(c_when, st, vis):
					closed_by = "when"
					closed_reason = _format_cond(c_when)

		# 3. choice @cost check
		if closed_by == "":
			var cost_v: Variant = choice.get("cost", [])
			var cost_arr: Array = cost_v as Array if cost_v is Array else []
			var needs: Dictionary = _cost_needs(cost_arr)
			var unmet: PackedStringArray = PackedStringArray()
			for var_name_v: Variant in needs.keys():
				var var_name: String = str(var_name_v)
				var need: float = float(needs[var_name_v])
				if need > 0.0:
					if not _compare_values(st.get(var_name, null), ">=", need):
						unmet.append("%s >= %s" % [var_name, _format_num(need)])
			if not unmet.is_empty():
				closed_by = "cost"
				closed_reason = "@cost needs %s" % " and ".join(unmet)

		# 4. target passage @when check on state after choice cost + set
		if closed_by == "":
			var to_id: String = str(choice.get("to", ""))
			if to_id == RETURN_TARGET:
				if ret_to == "" or not _story.passages.has(ret_to):
					closed_by = "target"
					closed_reason = "no active interrupt to return from"
			elif not _story.passages.has(to_id):
				closed_by = "target"
				closed_reason = "missing target passage %s" % to_id
			else:
				var target_p: Dictionary = _story.get_passage(to_id)
				var t_when_v: Variant = target_p.get("when", null)
				if t_when_v is Dictionary and not (t_when_v as Dictionary).is_empty():
					var t_when: Dictionary = t_when_v as Dictionary
					var cost_v2: Variant = choice.get("cost", [])
					var set_v2: Variant = choice.get("set", [])
					var after_cost: Dictionary = apply_effects(st, cost_v2 as Array if cost_v2 is Array else [])
					var after_set: Dictionary = apply_effects(after_cost, set_v2 as Array if set_v2 is Array else [])
					if not _eval_cond_internal(t_when, after_set, vis):
						closed_by = "target"
						closed_reason = "%s needs %s on arrival" % [str(target_p.get("name", to_id)), _format_cond(t_when)]

		result.append({
			"index": i,
			"choice": choice,
			"open": closed_by == "",
			"closed_by": closed_by,
			"closed_reason": closed_reason,
		})

	return result


func choose(index: int) -> bool:
	if _story == null or _history.is_empty():
		return false
	var entries: Array[Dictionary] = get_choices()
	if index < 0 or index >= entries.size():
		return false
	var entry: Dictionary = entries[index]
	if not bool(entry.get("open", false)):
		return false

	var from_pid: String = current_id()
	var choice: Dictionary = entry["choice"] as Dictionary
	var prev_state: Dictionary = _current_state()
	var next_used_once: Dictionary = _current_used_once().duplicate(true)
	if bool(choice.get("once", false)):
		next_used_once[_once_key(from_pid, index)] = true

	var cost_v: Variant = choice.get("cost", [])
	var set_v: Variant = choice.get("set", [])
	var after_cost: Dictionary = apply_effects(prev_state, cost_v as Array if cost_v is Array else [])
	var after_choice: Dictionary = apply_effects(after_cost, set_v as Array if set_v is Array else [])
	var next_visits: Dictionary = _current_visits().duplicate(true)
	var to_id: String = str(choice.get("to", ""))

	if to_id == RETURN_TARGET:
		var back_id: String = _current_return_to()
		if back_id == "" or not _story.passages.has(back_id):
			return false
		var back_passage: Dictionary = _story.get_passage(back_id)
		_history.append({
			"passage_id": back_id,
			"state": after_choice.duplicate(true),
			"visits": next_visits,
			"used_once": next_used_once,
			"return_to": "",
			"turn": _current_turn() + 1,
			"cooldowns": _current_cooldowns().duplicate(true),
		})
		choice_taken.emit(from_pid, index, choice)
		_emit_cues(choice.get("cues", []))
		_emit_state_diffs(prev_state, after_choice)
		passage_entered.emit(back_id, back_passage)
		if is_over():
			story_ended.emit(back_id, bool(back_passage.get("ending", false)))
		return true

	if not _story.passages.has(to_id):
		return false
	var target_passage: Dictionary = _story.get_passage(to_id)
	next_visits[to_id] = int(next_visits.get(to_id, 0)) + 1
	var on_enter_v: Variant = target_passage.get("onEnter", [])
	var final_state: Dictionary = apply_effects(after_choice, on_enter_v as Array if on_enter_v is Array else [])

	_history.append({
		"passage_id": to_id,
		"state": final_state.duplicate(true),
		"visits": next_visits,
		"used_once": next_used_once,
		"return_to": _current_return_to(),
		"turn": _current_turn() + 1,
		"cooldowns": _current_cooldowns().duplicate(true),
	})

	choice_taken.emit(from_pid, index, choice)
	_emit_cues(choice.get("cues", []))
	_emit_state_diffs(prev_state, final_state)
	passage_entered.emit(to_id, target_passage)
	_emit_cues(target_passage.get("cues", []))

	# After a move to a passage (not a @return), an @auto interrupt whose @when now holds starts by itself
	# (highest priority first, then story order) as a step of its own on the same turn, so one undo()
	# takes back only the interrupt. A choice that links straight to an @auto interrupt does not start it again.
	var auto_id: String = _find_auto_interrupt(to_id)
	if auto_id != "":
		_enter_detour(auto_id, 0, _current_cooldowns())
		return true
	if is_over():
		story_ended.emit(to_id, bool(target_passage.get("ending", false)))
	return true


func get_interrupts() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	if _story == null or _history.is_empty():
		return result
	var in_interrupt: bool = _current_return_to() != ""
	var ended: bool = bool(current_passage().get("ending", false))
	var st: Dictionary = _current_state()
	var vis: Dictionary = _current_visits()

	for intr: Dictionary in _story.get_interrupts():
		var pid: String = str(intr.get("id", ""))
		var p: Dictionary = _story.get_passage(pid)
		var is_open: bool = not in_interrupt and not ended
		if is_open:
			var when_v: Variant = p.get("when", null)
			if when_v is Dictionary and not (when_v as Dictionary).is_empty():
				is_open = _eval_cond_internal(when_v as Dictionary, st, vis)
		result.append({
			"id": pid,
			"passage": p,
			"open": is_open,
		})
	return result


func trigger_interrupt(passage_id: String) -> bool:
	if _story == null or _history.is_empty():
		return false
	if _current_return_to() != "":
		return false
	if bool(current_passage().get("ending", false)):
		return false
	if not _story.passages.has(passage_id):
		return false
	var target: Dictionary = _story.get_passage(passage_id)
	if not RiverStory.is_interrupt_passage(target):
		return false
	var when_v: Variant = target.get("when", null)
	if when_v is Dictionary and not (when_v as Dictionary).is_empty():
		if not _eval_cond_internal(when_v as Dictionary, _current_state(), _current_visits()):
			return false

	var from_pid: String = current_id()
	var prev_state: Dictionary = _current_state()
	var next_visits: Dictionary = _current_visits().duplicate(true)
	next_visits[passage_id] = int(next_visits.get(passage_id, 0)) + 1
	var on_enter_v: Variant = target.get("onEnter", [])
	var next_state: Dictionary = apply_effects(prev_state, on_enter_v as Array if on_enter_v is Array else [])

	_history.append({
		"passage_id": passage_id,
		"state": next_state.duplicate(true),
		"visits": next_visits,
		"used_once": _current_used_once().duplicate(true),
		"return_to": from_pid,
		"turn": _current_turn(),
		"cooldowns": _current_cooldowns().duplicate(true),
	})

	_emit_state_diffs(prev_state, next_state)
	passage_entered.emit(passage_id, target)
	_emit_cues(target.get("cues", []))
	if is_over():
		story_ended.emit(passage_id, bool(target.get("ending", false)))
	return true


## The storylet passages, in story order, with whether each can be drawn now:
## { "id", "passage", "open", "weight", "priority", "cooldown_left" }. Open means its @when holds, it is off
## cooldown, no interrupt or storylet is running and the story has not ended.
func storylets() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	if _story == null or _history.is_empty():
		return result
	var in_detour: bool = _current_return_to() != ""
	var ended: bool = bool(current_passage().get("ending", false))
	var st: Dictionary = _current_state()
	var vis: Dictionary = _current_visits()
	var now: int = _current_turn()
	var cds: Dictionary = _current_cooldowns()
	for entry: Dictionary in _story.get_storylets():
		var pid: String = str(entry.get("id", ""))
		var p: Dictionary = _story.get_passage(pid)
		var left: int = maxi(0, int(cds.get(pid, 0)) - now)
		var is_open: bool = not in_detour and not ended and left == 0
		if is_open:
			var when_v: Variant = p.get("when", null)
			if when_v is Dictionary and not (when_v as Dictionary).is_empty():
				is_open = _eval_cond_internal(when_v as Dictionary, st, vis)
		result.append({
			"id": pid,
			"passage": p,
			"open": is_open,
			"weight": float(p.get("weight", 1.0)),
			"priority": int(p.get("priority", 0)),
			"cooldown_left": left,
		})
	return result


## Draw one open storylet: among those of the highest priority, one at random by weight. Enters it like an
## interrupt (a @return comes back here), starts its @cooldown and takes a turn. Returns the entered passage
## (with its "id"), or {} when none is open (nothing changes then). A `roll` in [0, 1) replaces the random
## number, for tests and replays.
func draw_storylet(rng: RandomNumberGenerator = null, roll: float = -1.0) -> Dictionary:
	var pool: Array[Dictionary] = []
	var best: int = 0
	for entry: Dictionary in storylets():
		if not bool(entry["open"]):
			continue
		var prio: int = int(entry["priority"])
		if pool.is_empty() or prio > best:
			pool.clear()
			best = prio
		if prio == best:
			pool.append(entry)
	if pool.is_empty():
		return {}
	var total: float = 0.0
	for entry: Dictionary in pool:
		total += float(entry["weight"])
	var unit: float = roll
	if unit < 0.0:
		unit = rng.randf() if rng != null else randf()
	var r: float = unit * total
	# Same walk as @river/core: the last entry catches r == total (randf() may return 1.0).
	var picked: Dictionary = pool[pool.size() - 1]
	for entry: Dictionary in pool:
		var w: float = float(entry["weight"])
		if r < w:
			picked = entry
			break
		r -= w
	var pid: String = str(picked["id"])
	var p: Dictionary = picked["passage"] as Dictionary
	var next_turn: int = _current_turn() + 1
	var cds: Dictionary = _current_cooldowns().duplicate(true)
	var cooldown: int = int(p.get("cooldown", 0))
	if cooldown > 0:
		cds[pid] = next_turn + cooldown
	_enter_detour(pid, 1, cds)
	storylet_drawn.emit(pid)
	var drawn: Dictionary = p.duplicate(false)
	drawn["id"] = pid
	return drawn


func render_text(raw: String = "") -> String:
	var source: String = raw
	if source == "" and _story != null and not _history.is_empty():
		source = str(current_passage().get("text", ""))
	return _render_template(source)


func get_blocks() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	if _story == null or _history.is_empty():
		return result
	var passage: Dictionary = current_passage()
	var blocks_v: Variant = passage.get("blocks", null)
	if blocks_v is Array and not (blocks_v as Array).is_empty():
		for item_v: Variant in (blocks_v as Array):
			if not (item_v is Dictionary):
				continue
			var block: Dictionary = (item_v as Dictionary).duplicate(true)
			if block.has("text") and block["text"] is String:
				block["text"] = _render_template(block["text"] as String)
			result.append(block)
		return result
	var raw_text: String = str(passage.get("text", ""))
	result.append({
		"kind": "narration",
		"text": _render_template(raw_text),
	})
	return result


func to_dict() -> Dictionary:
	var hist_copy: Array[Dictionary] = []
	for step: Dictionary in _history:
		hist_copy.append(step.duplicate(true))
	return {
		"version": 1,
		"story_id": _story.story_id if _story != null else "",
		"passage_id": current_id(),
		"state": get_state(),
		"visits": get_visits(),
		"used_once": _current_used_once().duplicate(true),
		"return_to": _current_return_to(),
		"turn": get_turn(),
		"cooldowns": get_cooldowns(),
		"history": hist_copy,
	}


func from_dict(snap: Dictionary, story: RiverStory) -> void:
	_story = story
	_history.clear()
	if _story == null:
		push_error("RiverRunner.from_dict: story is null")
		return

	var hist_v: Variant = snap.get("history", null)
	if hist_v is Array and not (hist_v as Array).is_empty():
		for step_v: Variant in (hist_v as Array):
			if not (step_v is Dictionary):
				continue
			_history.append(_normalize_step(step_v as Dictionary))
		return

	var pid: String = str(snap.get("passage_id", _story.start_id))
	if pid == "" or not _story.passages.has(pid):
		push_error("RiverRunner.from_dict: invalid passage_id '%s'" % pid)
		return
	_history.append(_normalize_step({
		"passage_id": pid,
		"state": snap.get("state", _story.initial_state()),
		"visits": snap.get("visits", { pid: 1 }),
		"used_once": snap.get("used_once", {}),
		"return_to": str(snap.get("return_to", "")),
		"turn": snap.get("turn", 0),
		"cooldowns": snap.get("cooldowns", {}),
	}))


# --- Internal helpers ---

func _top() -> Dictionary:
	return _history[_history.size() - 1]


func _current_state() -> Dictionary:
	if _history.is_empty():
		return {}
	return _top()["state"] as Dictionary


func _current_visits() -> Dictionary:
	if _history.is_empty():
		return {}
	return _top()["visits"] as Dictionary


func _current_used_once() -> Dictionary:
	if _history.is_empty():
		return {}
	return _top()["used_once"] as Dictionary


func _current_return_to() -> String:
	if _history.is_empty():
		return ""
	return str(_top().get("return_to", ""))


func _current_turn() -> int:
	if _history.is_empty():
		return 0
	return int(_top().get("turn", 0))


func _current_cooldowns() -> Dictionary:
	if _history.is_empty():
		return {}
	var cds_v: Variant = _top().get("cooldowns", {})
	return cds_v as Dictionary if cds_v is Dictionary else {}


## The @auto interrupt that starts after arriving at `arrived_id`, or "" for none. Checked against the new top
## step: no detour is running, the arrived passage is not an ending, and the interrupt's @when holds for the new
## state and visits. Highest priority wins; equal priorities keep story order.
func _find_auto_interrupt(arrived_id: String) -> String:
	if _current_return_to() != "" or bool(current_passage().get("ending", false)):
		return ""
	var st: Dictionary = _current_state()
	var vis: Dictionary = _current_visits()
	var found: String = ""
	var found_priority: int = 0
	for intr: Dictionary in _story.get_interrupts():
		if not bool(intr.get("auto", false)):
			continue
		var pid: String = str(intr.get("id", ""))
		if pid == arrived_id:
			continue
		var prio: int = int(intr.get("priority", 0))
		if found != "" and prio <= found_priority:
			continue
		var when_v: Variant = intr.get("when", null)
		if when_v is Dictionary and not (when_v as Dictionary).is_empty():
			if not _eval_cond_internal(when_v as Dictionary, st, vis):
				continue
		found = pid
		found_priority = prio
	return found


## Enter a detour (auto interrupt or storylet) from the current passage as a step of its own. An ending has
## nowhere to return to. `turns` is how many turns it takes; `cds` becomes the step's cooldowns.
func _enter_detour(passage_id: String, turns: int, cds: Dictionary) -> void:
	var target: Dictionary = _story.get_passage(passage_id)
	var from_pid: String = current_id()
	var prev_state: Dictionary = _current_state()
	var next_visits: Dictionary = _current_visits().duplicate(true)
	next_visits[passage_id] = int(next_visits.get(passage_id, 0)) + 1
	var on_enter_v: Variant = target.get("onEnter", [])
	var next_state: Dictionary = apply_effects(prev_state, on_enter_v as Array if on_enter_v is Array else [])
	var is_ending: bool = bool(target.get("ending", false))
	_history.append({
		"passage_id": passage_id,
		"state": next_state.duplicate(true),
		"visits": next_visits,
		"used_once": _current_used_once().duplicate(true),
		"return_to": "" if is_ending else from_pid,
		"turn": _current_turn() + turns,
		"cooldowns": cds.duplicate(true),
	})
	_emit_state_diffs(prev_state, next_state)
	passage_entered.emit(passage_id, target)
	_emit_cues(target.get("cues", []))
	if is_over():
		story_ended.emit(passage_id, is_ending)


func _current_passage_visits() -> int:
	if _history.is_empty():
		return 1
	var vis: Dictionary = _current_visits()
	return int(vis.get(current_id(), 1))


func _once_key(passage_id: String, choice_index: int) -> String:
	return "%s:%d" % [passage_id, choice_index]


func _var_decl(var_name: String) -> Dictionary:
	if _story == null or not _story.state_schema.has(var_name):
		return {}
	var raw: Variant = _story.state_schema[var_name]
	if raw is Dictionary:
		return raw as Dictionary
	return {}


func _settle_number(v: float, decl: Dictionary) -> Variant:
	if decl.is_empty():
		return v
	var var_type: String = str(decl.get("type", ""))
	if var_type != "number" and var_type != "int":
		return v
	var out: float = float(int(v)) if var_type == "int" else v
	if decl.has("min") and decl["min"] != null:
		var min_v: float = float(decl["min"])
		if out < min_v:
			out = min_v
	if decl.has("max") and decl["max"] != null:
		var max_v: float = float(decl["max"])
		if out > max_v:
			out = max_v
	if var_type == "int":
		return int(out)
	return out


func _settle_var_value(var_name: String, value: Variant) -> Variant:
	var decl: Dictionary = _var_decl(var_name)
	if decl.is_empty():
		return value
	var var_type: String = str(decl.get("type", ""))
	match var_type:
		"int":
			if value is int or value is float:
				return _settle_number(float(value), decl)
			return int(value)
		"number":
			if value is int or value is float:
				return _settle_number(float(value), decl)
			return float(value)
		"bool":
			return bool(value)
		"enum":
			return str(value)
		_:
			return value


func _normalize_step(raw_step: Dictionary) -> Dictionary:
	var pid: String = str(raw_step.get("passage_id", ""))
	var raw_state_v: Variant = raw_step.get("state", {})
	var norm_state: Dictionary = {}
	if raw_state_v is Dictionary:
		var raw_state: Dictionary = raw_state_v as Dictionary
		for k_v: Variant in raw_state.keys():
			var k: String = str(k_v)
			norm_state[k] = _settle_var_value(k, raw_state[k_v])

	var raw_vis_v: Variant = raw_step.get("visits", {})
	var norm_vis: Dictionary = {}
	if raw_vis_v is Dictionary:
		var raw_vis: Dictionary = raw_vis_v as Dictionary
		for k_v: Variant in raw_vis.keys():
			norm_vis[str(k_v)] = int(raw_vis[k_v])

	var raw_once_v: Variant = raw_step.get("used_once", {})
	var norm_once: Dictionary = {}
	if raw_once_v is Dictionary:
		var raw_once: Dictionary = raw_once_v as Dictionary
		for k_v: Variant in raw_once.keys():
			if bool(raw_once[k_v]):
				norm_once[str(k_v)] = true

	var raw_cds_v: Variant = raw_step.get("cooldowns", {})
	var norm_cds: Dictionary = {}
	if raw_cds_v is Dictionary:
		var raw_cds: Dictionary = raw_cds_v as Dictionary
		for k_v: Variant in raw_cds.keys():
			norm_cds[str(k_v)] = int(raw_cds[k_v])

	return {
		"passage_id": pid,
		"state": norm_state,
		"visits": norm_vis,
		"used_once": norm_once,
		"return_to": str(raw_step.get("return_to", "")),
		"turn": int(raw_step.get("turn", 0)),
		"cooldowns": norm_cds,
	}


func _emit_state_diffs(prev_state: Dictionary, next_state: Dictionary) -> void:
	var seen: Dictionary = {}
	for k_v: Variant in next_state.keys():
		var k: String = str(k_v)
		seen[k] = true
		var old_v: Variant = prev_state.get(k, null)
		var new_v: Variant = next_state[k_v]
		if not _values_equal(old_v, new_v):
			state_changed.emit(k, old_v, new_v)
	for k_v: Variant in prev_state.keys():
		var k: String = str(k_v)
		if not seen.has(k):
			state_changed.emit(k, prev_state[k_v], null)


func _emit_cues(raw_cues: Variant) -> void:
	if not (raw_cues is Array):
		return
	for item_v: Variant in (raw_cues as Array):
		if item_v is Dictionary:
			var d: Dictionary = item_v as Dictionary
			var cue_name: String = str(d.get("name", ""))
			var args_v: Variant = d.get("args", "")
			var cue_args: String = ""
			if args_v is Array:
				var parts: PackedStringArray = PackedStringArray()
				for a_v: Variant in (args_v as Array):
					parts.append(str(a_v))
				cue_args = " ".join(parts)
			elif args_v != null:
				cue_args = str(args_v)
			if cue_name != "":
				cue_triggered.emit(cue_name, cue_args)
		elif item_v is String:
			var s: String = (item_v as String).strip_edges()
			if s == "":
				continue
			var space_idx: int = s.find(" ")
			if space_idx == -1:
				cue_triggered.emit(s, "")
			else:
				cue_triggered.emit(s.substr(0, space_idx), s.substr(space_idx + 1).strip_edges())


func _cost_needs(cost_effects: Array) -> Dictionary:
	var needs: Dictionary = {}
	for eff_v: Variant in cost_effects:
		if not (eff_v is Dictionary):
			continue
		var eff: Dictionary = eff_v as Dictionary
		if str(eff.get("op", "")) == "add":
			var amt_v: Variant = eff.get("amount", 0)
			if amt_v is int or amt_v is float:
				var var_name: String = str(eff.get("variable", ""))
				needs[var_name] = float(needs.get(var_name, 0.0)) - float(amt_v)
	return needs


func _eval_cond_internal(cond: Dictionary, st: Dictionary, vis: Dictionary) -> bool:
	if cond.is_empty():
		return true
	var kind: String = str(cond.get("kind", ""))
	match kind:
		"and":
			var terms_v: Variant = cond.get("terms", [])
			if not (terms_v is Array):
				return true
			for t_v: Variant in (terms_v as Array):
				if t_v is Dictionary and not _eval_cond_internal(t_v as Dictionary, st, vis):
					return false
			return true
		"or":
			var terms_v: Variant = cond.get("terms", [])
			if not (terms_v is Array):
				return false
			for t_v: Variant in (terms_v as Array):
				if t_v is Dictionary and _eval_cond_internal(t_v as Dictionary, st, vis):
					return true
			return false
		"not":
			var term_v: Variant = cond.get("term", {})
			if term_v is Dictionary:
				return not _eval_cond_internal(term_v as Dictionary, st, vis)
			return true
		"cmp":
			var var_name: String = str(cond.get("variable", ""))
			var op: String = str(cond.get("op", "=="))
			var expected: Variant = cond.get("value", null)
			var actual: Variant = st.get(var_name, null)
			return _compare_values(actual, op, expected)
		"visit":
			var pid: String = str(cond.get("passageId", cond.get("passage_id", "")))
			var op: String = str(cond.get("op", ">="))
			var expected: Variant = cond.get("value", 1)
			var count: int = int(vis.get(pid, 0))
			return _compare_values(count, op, expected)
		_:
			return false


func _values_equal(a: Variant, b: Variant) -> bool:
	if a == null and b == null:
		return true
	if a == null or b == null:
		return false
	if (a is int or a is float) and (b is int or b is float):
		return float(a) == float(b)
	if a is bool and b is bool:
		return (a as bool) == (b as bool)
	if a is String and b is String:
		return (a as String) == (b as String)
	return false


func _compare_values(a: Variant, op: String, b: Variant) -> bool:
	if op == "==":
		return _values_equal(a, b)
	if op == "!=":
		return not _values_equal(a, b)
	if not ((a is int or a is float) and (b is int or b is float)):
		return false
	var af: float = float(a)
	var bf: float = float(b)
	match op:
		"<":
			return af < bf
		"<=":
			return af <= bf
		">":
			return af > bf
		">=":
			return af >= bf
		_:
			return false


func _format_num(n: float) -> String:
	if n == floor(n) and absf(n) < 9007199254740991.0:
		return str(int(n))
	return str(n)


func _format_value(v: Variant) -> String:
	if v is int:
		return str(v as int)
	if v is float:
		return _format_num(v as float)
	if v is bool:
		return "true" if (v as bool) else "false"
	return str(v)


func _format_cond(cond: Dictionary) -> String:
	var kind: String = str(cond.get("kind", ""))
	match kind:
		"cmp":
			return "%s %s %s" % [str(cond.get("variable", "")), str(cond.get("op", "==")), _format_value(cond.get("value", ""))]
		"visit":
			var pid: String = str(cond.get("passageId", cond.get("passage_id", "")))
			var op: String = str(cond.get("op", ">="))
			var val: Variant = cond.get("value", 1)
			if op == ">=" and _values_equal(val, 1):
				return "visited(%s)" % pid
			return "visits(%s) %s %s" % [pid, op, _format_value(val)]
		"and":
			var parts: PackedStringArray = PackedStringArray()
			var terms_v: Variant = cond.get("terms", [])
			if terms_v is Array:
				for t_v: Variant in (terms_v as Array):
					if t_v is Dictionary:
						parts.append(_wrap_cond(t_v as Dictionary))
			return " and ".join(parts)
		"or":
			var parts: PackedStringArray = PackedStringArray()
			var terms_v: Variant = cond.get("terms", [])
			if terms_v is Array:
				for t_v: Variant in (terms_v as Array):
					if t_v is Dictionary:
						parts.append(_wrap_cond(t_v as Dictionary))
			return " or ".join(parts)
		"not":
			var term_v: Variant = cond.get("term", {})
			if term_v is Dictionary:
				return "not %s" % _wrap_cond(term_v as Dictionary)
			return "not"
		_:
			return ""


func _wrap_cond(cond: Dictionary) -> String:
	var kind: String = str(cond.get("kind", ""))
	if kind == "and" or kind == "or":
		return "(%s)" % _format_cond(cond)
	return _format_cond(cond)


# --- Inline reactive template renderer ---

func _render_template(text: String) -> String:
	var out: String = ""
	var i: int = 0
	var n: int = text.length()
	while i < n:
		var ch: String = text.substr(i, 1)
		if ch == "\\" and i + 1 < n:
			var nxt: String = text.substr(i + 1, 1)
			if nxt == "{" or nxt == "}":
				out += nxt
				i += 2
				continue
		if ch == "{":
			var close_idx: int = _find_matching_brace(text, i)
			if close_idx == -1:
				out += ch
				i += 1
				continue
			var inner: String = text.substr(i + 1, close_idx - i - 1)
			out += _eval_template_expr(inner)
			i = close_idx + 1
			continue
		out += ch
		i += 1
	return out


func _find_matching_brace(text: String, open_idx: int) -> int:
	var depth: int = 0
	var i: int = open_idx
	var n: int = text.length()
	while i < n:
		var ch: String = text.substr(i, 1)
		if ch == "\\" and i + 1 < n:
			i += 2
			continue
		if ch == "{":
			depth += 1
		elif ch == "}":
			depth -= 1
			if depth == 0:
				return i
		i += 1
	return -1


func _split_top_level(text: String, sep: String) -> Array[String]:
	var parts: Array[String] = []
	var depth: int = 0
	var start: int = 0
	var i: int = 0
	var n: int = text.length()
	while i < n:
		var ch: String = text.substr(i, 1)
		if ch == "\\" and i + 1 < n:
			i += 2
			continue
		if ch == "{":
			depth += 1
		elif ch == "}":
			if depth > 0:
				depth -= 1
		elif ch == sep and depth == 0:
			parts.append(text.substr(start, i - start))
			start = i + 1
		i += 1
	parts.append(text.substr(start, n - start))
	return parts


func _find_top_level_colon(text: String) -> int:
	var depth: int = 0
	var paren_depth: int = 0
	var in_quote: bool = false
	var i: int = 0
	var n: int = text.length()
	while i < n:
		var ch: String = text.substr(i, 1)
		if ch == "\\" and i + 1 < n:
			i += 2
			continue
		if ch == "\"":
			in_quote = not in_quote
		elif not in_quote:
			if ch == "{":
				depth += 1
			elif ch == "}":
				if depth > 0:
					depth -= 1
			elif ch == "(":
				paren_depth += 1
			elif ch == ")":
				if paren_depth > 0:
					paren_depth -= 1
			elif ch == ":" and depth == 0 and paren_depth == 0:
				return i
		i += 1
	return -1


func _eval_template_expr(inner: String) -> String:
	var trimmed: String = inner.strip_edges()
	if trimmed == "":
		return "{%s}" % inner

	# {when <cond>: <then> | <else>} or {when <cond>: <then>}
	if trimmed.begins_with("when ") or trimmed.begins_with("when\t"):
		var colon_idx: int = _find_top_level_colon(trimmed)
		if colon_idx != -1:
			var cond_str: String = trimmed.substr(4, colon_idx - 4).strip_edges()
			var body: String = trimmed.substr(colon_idx + 1)
			var branches: Array[String] = _split_top_level(body, "|")
			var parsed_cond: Dictionary = _parse_cond_str(cond_str)
			if not parsed_cond.is_empty() and eval_cond(parsed_cond):
				return _render_template(branches[0].strip_edges())
			if branches.size() >= 2:
				var else_parts: PackedStringArray = PackedStringArray()
				for bi: int in range(1, branches.size()):
					else_parts.append(branches[bi])
				return _render_template("|".join(else_parts).strip_edges())
			return ""

	# {once: <text>}
	if trimmed.begins_with("once:"):
		var body: String = trimmed.substr(5).strip_edges()
		if _current_passage_visits() == 1:
			return _render_template(body)
		return ""

	# {cycle: A | B | C}
	if trimmed.begins_with("cycle:"):
		var body: String = trimmed.substr(6)
		var options: Array[String] = _split_top_level(body, "|")
		if options.is_empty():
			return ""
		var vcount: int = maxi(_current_passage_visits(), 1)
		var idx: int = (vcount - 1) % options.size()
		return _render_template(options[idx].strip_edges())

	# {shuffle: A | B | C}
	if trimmed.begins_with("shuffle:"):
		var body: String = trimmed.substr(8)
		var options: Array[String] = _split_top_level(body, "|")
		if options.is_empty():
			return ""
		var seed_str: String = "%s:%d:%s" % [current_id(), _current_passage_visits(), trimmed]
		var idx: int = absi(seed_str.hash()) % options.size()
		return _render_template(options[idx].strip_edges())

	# {var_name}
	if _is_valid_var_name(trimmed):
		var st: Dictionary = _current_state()
		if st.has(trimmed):
			return _format_value(st[trimmed])

	return "{%s}" % inner


func _is_valid_var_name(s: String) -> bool:
	if s.is_empty():
		return false
	for i: int in range(s.length()):
		var code: int = s.unicode_at(i)
		var is_alpha: bool = (code >= 65 and code <= 90) or (code >= 97 and code <= 122) or code == 95
		var is_digit: bool = code >= 48 and code <= 57
		if i == 0:
			if not is_alpha:
				return false
		else:
			if not (is_alpha or is_digit or code == 46):
				return false
	return true


# --- Inline condition string parser ---

func _tokenize_cond(src: String) -> Array[Dictionary]:
	var toks: Array[Dictionary] = []
	var i: int = 0
	var n: int = src.length()
	while i < n:
		var ch: String = src.substr(i, 1)
		if ch == " " or ch == "\t" or ch == "\r" or ch == "\n":
			i += 1
			continue
		if ch == "(":
			toks.append({ "t": "lp" })
			i += 1
			continue
		if ch == ")":
			toks.append({ "t": "rp" })
			i += 1
			continue
		if i + 1 < n:
			var two: String = src.substr(i, 2)
			if two == "==" or two == "!=" or two == "<=" or two == ">=":
				toks.append({ "t": "op", "v": two })
				i += 2
				continue
		if ch == "<" or ch == ">":
			toks.append({ "t": "op", "v": ch })
			i += 1
			continue
		if ch == "\"":
			var j: int = i + 1
			var s: String = ""
			while j < n and src.substr(j, 1) != "\"":
				if src.substr(j, 1) == "\\" and j + 1 < n:
					j += 1
				s += src.substr(j, 1)
				j += 1
			if j >= n:
				return []
			toks.append({ "t": "str", "v": s })
			i = j + 1
			continue
		var code: int = src.unicode_at(i)
		var is_digit: bool = code >= 48 and code <= 57
		var is_neg_num: bool = ch == "-" and i + 1 < n and src.unicode_at(i + 1) >= 48 and src.unicode_at(i + 1) <= 57
		if is_digit or is_neg_num:
			var j: int = i + (1 if ch == "-" else 0)
			while j < n and src.unicode_at(j) >= 48 and src.unicode_at(j) <= 57:
				j += 1
			if j < n and src.substr(j, 1) == "." and j + 1 < n and src.unicode_at(j + 1) >= 48 and src.unicode_at(j + 1) <= 57:
				j += 1
				while j < n and src.unicode_at(j) >= 48 and src.unicode_at(j) <= 57:
					j += 1
			toks.append({ "t": "num", "v": float(src.substr(i, j - i)) })
			i = j
			continue
		var is_ident_start: bool = (code >= 65 and code <= 90) or (code >= 97 and code <= 122) or code == 95
		if is_ident_start:
			var j: int = i + 1
			while j < n:
				var c2: int = src.unicode_at(j)
				var ok: bool = (c2 >= 65 and c2 <= 90) or (c2 >= 97 and c2 <= 122) or (c2 >= 48 and c2 <= 57) or c2 == 95 or c2 == 46 or c2 == 45
				if not ok:
					break
				j += 1
			toks.append({ "t": "ident", "v": src.substr(i, j - i) })
			i = j
			continue
		return []
	return toks


func _parse_cond_str(src: String) -> Dictionary:
	var toks: Array[Dictionary] = _tokenize_cond(src)
	if toks.is_empty():
		return {}
	var cursor: Array[int] = [0]
	var cond: Dictionary = _parse_or(toks, cursor)
	if cond.is_empty() or cursor[0] < toks.size():
		return {}
	return cond


func _peek_tok(toks: Array[Dictionary], cursor: Array[int]) -> Dictionary:
	if cursor[0] >= toks.size():
		return {}
	return toks[cursor[0]]


func _is_word_tok(tok: Dictionary, word: String) -> bool:
	return not tok.is_empty() and str(tok.get("t", "")) == "ident" and str(tok.get("v", "")) == word


func _parse_or(toks: Array[Dictionary], cursor: Array[int]) -> Dictionary:
	var first: Dictionary = _parse_and(toks, cursor)
	if first.is_empty():
		return {}
	var terms: Array[Dictionary] = [first]
	while _is_word_tok(_peek_tok(toks, cursor), "or"):
		cursor[0] += 1
		var rhs: Dictionary = _parse_and(toks, cursor)
		if rhs.is_empty():
			return {}
		terms.append(rhs)
	if terms.size() == 1:
		return terms[0]
	return { "kind": "or", "terms": terms }


func _parse_and(toks: Array[Dictionary], cursor: Array[int]) -> Dictionary:
	var first: Dictionary = _parse_unary(toks, cursor)
	if first.is_empty():
		return {}
	var terms: Array[Dictionary] = [first]
	while _is_word_tok(_peek_tok(toks, cursor), "and"):
		cursor[0] += 1
		var rhs: Dictionary = _parse_unary(toks, cursor)
		if rhs.is_empty():
			return {}
		terms.append(rhs)
	if terms.size() == 1:
		return terms[0]
	return { "kind": "and", "terms": terms }


func _parse_unary(toks: Array[Dictionary], cursor: Array[int]) -> Dictionary:
	var tok: Dictionary = _peek_tok(toks, cursor)
	if tok.is_empty():
		return {}
	if _is_word_tok(tok, "not"):
		cursor[0] += 1
		var inner: Dictionary = _parse_unary(toks, cursor)
		if inner.is_empty():
			return {}
		return { "kind": "not", "term": inner }
	if str(tok.get("t", "")) == "lp":
		cursor[0] += 1
		var grouped: Dictionary = _parse_or(toks, cursor)
		if grouped.is_empty():
			return {}
		if str(_peek_tok(toks, cursor).get("t", "")) != "rp":
			return {}
		cursor[0] += 1
		return grouped
	if str(tok.get("t", "")) == "ident":
		var ident: String = str(tok.get("v", ""))
		if ident == "and" or ident == "or" or ident == "not" or ident == "true" or ident == "false":
			return {}
		cursor[0] += 1
		# visited(id) or visits(id) [op num]
		if (ident == "visited" or ident == "visits") and str(_peek_tok(toks, cursor).get("t", "")) == "lp":
			cursor[0] += 1
			var arg_tok: Dictionary = _peek_tok(toks, cursor)
			var arg_t: String = str(arg_tok.get("t", ""))
			if arg_t != "ident" and arg_t != "str":
				return {}
			var pid: String = str(arg_tok.get("v", ""))
			cursor[0] += 1
			if str(_peek_tok(toks, cursor).get("t", "")) != "rp":
				return {}
			cursor[0] += 1
			if ident == "visits" and str(_peek_tok(toks, cursor).get("t", "")) == "op":
				var op_str: String = str(_peek_tok(toks, cursor).get("v", ""))
				cursor[0] += 1
				var val_pair: Array = _parse_value(toks, cursor)
				if not bool(val_pair[0]):
					return {}
				return { "kind": "visit", "passageId": pid, "op": op_str, "value": val_pair[1] }
			return { "kind": "visit", "passageId": pid, "op": ">=", "value": 1 }

		var next_tok: Dictionary = _peek_tok(toks, cursor)
		if str(next_tok.get("t", "")) != "op":
			return { "kind": "cmp", "variable": ident, "op": "==", "value": true }
		var op_s: String = str(next_tok.get("v", ""))
		cursor[0] += 1
		var val_res: Array = _parse_value(toks, cursor)
		if not bool(val_res[0]):
			return {}
		return { "kind": "cmp", "variable": ident, "op": op_s, "value": val_res[1] }
	return {}


func _parse_value(toks: Array[Dictionary], cursor: Array[int]) -> Array:
	var tok: Dictionary = _peek_tok(toks, cursor)
	if tok.is_empty():
		return [false, null]
	var t: String = str(tok.get("t", ""))
	cursor[0] += 1
	if t == "num" or t == "str":
		return [true, tok.get("v")]
	if t == "ident":
		var v: String = str(tok.get("v", ""))
		if v == "true":
			return [true, true]
		if v == "false":
			return [true, false]
		if v == "and" or v == "or" or v == "not":
			return [false, null]
		return [true, v]
	return [false, null]
