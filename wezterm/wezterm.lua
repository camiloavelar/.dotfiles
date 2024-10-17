local wezterm = require("wezterm")
local config = {}
local act = wezterm.action
local mux = wezterm.mux

config.font = wezterm.font_with_fallback({
	{ family = "JetbrainsMono Nerd Font", weight = "DemiBold" },
	{ family = "MesloLGL Nerd Font", weight = "Regular" },
})
config.font_size = 16
config.color_scheme = "Catppuccin Mocha"
config.enable_tab_bar = false
config.window_background_opacity = 1
config.window_background_opacity = 0.9
config.disable_default_key_bindings = true
config.window_decorations = "RESIZE"
config.colors = {
	foreground = "#cdd6f4",
	background = "black",
}

wezterm.on("gui-startup", function(cmd)
	local _, _, window = mux.spawn_window(cmd or {})
	window:gui_window():toggle_fullscreen()
end)

config.window_padding = {
	left = 2,
	right = 2,
	top = 0,
	bottom = 0,
}

config.keys = {
	{ key = "LeftArrow", mods = "OPT", action = wezterm.action({ SendString = "\x1bb" }) },
	{ key = "RightArrow", mods = "OPT", action = wezterm.action({ SendString = "\x1bf" }) },
	{ key = "a", mods = "CTRL", action = act.QuitApplication },
	{ key = "a", mods = "SHIFT|CTRL", action = act.QuitApplication },
	{ key = "Enter", mods = "ALT", action = act.ToggleFullScreen },
	{ key = "c", mods = "SHIFT|CTRL", action = act.CopyTo("Clipboard") },
	{ key = "c", mods = "SUPER", action = act.CopyTo("Clipboard") },
	{ key = "v", mods = "SHIFT|CTRL", action = act.PasteFrom("Clipboard") },
	{ key = "v", mods = "SUPER", action = act.PasteFrom("Clipboard") },
	{ key = "=", mods = "CTRL", action = wezterm.action.IncreaseFontSize },
	{ key = "-", mods = "CTRL", action = wezterm.action.DecreaseFontSize },
}

return config
