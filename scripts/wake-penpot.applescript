-- Bring the Penpot tab to the front so the browser stops suspending the plugin.
--
-- Why this exists: a background or occluded tab gets frozen by the browser, and
-- the MCP plugin stops answering with "the Penpot plugin tab appears to be
-- suspended by the browser (no heartbeat for Ns)". Clicking the tab fixes it.
--
-- Use it when you want to wake Penpot without touching the mouse:
--
--   osascript scripts/wake-penpot.applescript
--
-- Or from another machine over SSH, which is how this was tested:
--
--   ssh <penpot-host> 'osascript' < scripts/wake-penpot.applescript
--
-- Adjust the app name and the URL fragment for your setup. Arc and Chrome are
-- both Chromium, so the AppleScript dictionary is the same.

on run
	set penpotFragment to "localhost:9001/#/workspace"
	set browserName to "Google Chrome"
	-- set browserName to "Arc"
	-- set browserName to "Brave Browser"

	tell application browserName
		activate
		repeat with w in windows
			set i to 0
			repeat with t in tabs of w
				set i to i + 1
				if (URL of t) contains penpotFragment then
					set active tab index of w to i
					set index of w to 1
					return "focused Penpot tab " & i
				end if
			end repeat
		end repeat
		return "no Penpot tab found for " & penpotFragment
	end tell
end run