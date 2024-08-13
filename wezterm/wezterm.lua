local wezterm = require("wezterm")
local config = {}
local act = wezterm.action
local mux = wezterm.mux

config.font = wezterm.font("JetbrainsMono Nerd Font")
config.font_size = 14
config.color_scheme = 'Catppuccin Mocha'
config.enable_tab_bar = false
config.window_background_opacity = 0.9
config.disable_default_key_bindings = true
config.window_decorations = "RESIZE"
config.colors = {
  foreground = '#cdd6f4',
  background = 'black',
}

wezterm.on("gui-startup", function(cmd)
  local tab, pane, window = mux.spawn_window(cmd or {})
  window:gui_window():toggle_fullscreen()
end)

config.window_padding = {
  left = 2,
  right = 2,
  top = 0,
  bottom = 0,
}

config.keys = {
	{ key = "q", mods = "CTRL", action = act.QuitApplication },
	{ key = "q", mods = "SHIFT|CTRL", action = act.QuitApplication },
	{ key = "Enter", mods = "ALT", action = act.ToggleFullScreen },
	{ key = "c", mods = "SHIFT|CTRL", action = act.CopyTo("Clipboard") },
	{ key = "c", mods = "SUPER", action = act.CopyTo("Clipboard") },
	{ key = "v", mods = "SHIFT|CTRL", action = act.PasteFrom("Clipboard") },
	{ key = "v", mods = "SUPER", action = act.PasteFrom("Clipboard") },
}

return config
