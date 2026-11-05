package relay

import (
	"slices"
	"strings"
)

// The analytics panel shows these human names for the event names Cockpit, the site, and the
// install script send. Unknown names fall back to humanizeName.
var analyticsStepLabels = map[string]string{
	"launch":           "Server started",
	"first-launch":     "First launch",
	"auth":             "GitHub sign-in state",
	"auth-setup":       "Started GitHub sign-in",
	"signed-in":        "GitHub signed in",
	"repos-configured": "Repos chosen",
	"relay-connected":  "First relay connection",
	"pr-opened":        "Opened a PR",
	"merge-approval":   "Approved for safe merge",
	"mark-ready":       "Marked ready",
	"visit":            "Site visit",
	"saw-install":      "Saw install command",
	"copy-install":     "Copied install command",
	"github-app-setup": "GitHub App setup",
	"script-start":     "Install script started",
	"script-done":      "Install script finished",
	"script-failed":    "Install script failed",
}

var analyticsMutationLabels = map[string]string{
	"merge":                  "Merge PR",
	"comment":                "Comment",
	"review-verdict":         "Submit review",
	"update-branch":          "Update branch",
	"close":                  "Close PR",
	"ready-for-review":       "Ready for review",
	"convert-to-draft":       "Convert to draft",
	"auto-merge":             "Auto-merge",
	"github-auto-merge":      "GitHub auto-merge",
	"inline-comment":         "Inline comment",
	"pending-inline-comment": "Pending inline comment",
	"edit-pending-comment":   "Edit pending comment",
	"delete-pending-comment": "Delete pending comment",
	"discard-pending-review": "Discard pending review",
	"reply-to-thread":        "Reply to thread",
	"resolve-thread":         "Resolve thread",
	"edit-body":              "Edit description",
	"edit-title":             "Edit title",
	"assign":                 "Assign",
	"unassign":               "Unassign",
	"request-reviewers":      "Request reviewers",
	"unrequest-reviewers":    "Remove review request",
	"add-labels":             "Add labels",
	"remove-labels":          "Remove labels",
}

// Shortcut names follow the Cockpit cheatsheet; the UI spells punctuation keys as words.
var analyticsKeyLabels = map[string]string{
	"m":                 "Merge",
	"shift+m":           "Force merge",
	"c":                 "Comment",
	"shift+c":           "Close PR",
	"r":                 "Reply",
	"e":                 "Inline editor / archive",
	"shift+e":           "External editor",
	"v":                 "Review",
	"s":                 "Assign / pin",
	"n":                 "Clear marked ready",
	"q":                 "Request review",
	"p":                 "Prompt agent",
	"u":                 "Update branch",
	"x":                 "Close / tests",
	"h":                 "Remind me / file history",
	"o":                 "Open on GitHub",
	"t":                 "Switch branch",
	"z":                 "Undo archive",
	"b":                 "Set aside / bring back",
	"d":                 "Drafts / files and conversation",
	"j":                 "Move down",
	"k":                 "Move up",
	"shift+j":           "Next file or PR",
	"shift+k":           "Previous file or PR",
	"g":                 "Top",
	"shift+g":           "Bottom",
	"home":              "Top",
	"enter":             "Open PR",
	"escape":            "Back / close",
	"tab":               "Cycle views",
	"slash":             "Search / filter",
	"question":          "Shortcut cheatsheet",
	"cmd+k":             "Jump to PR",
	"cmd+i":             "Inbox",
	"cmd+e":             "Actions",
	"cmd+comma":         "Settings",
	"cmd+n":             "New window",
	"cmd+f":             "Filter",
	"cmd+g":             "Set-aside PRs",
	"shift+a":           "Archived",
	"shift+h":           "Back",
	"shift+l":           "Forward",
	"cmd+bracket-left":  "Back",
	"cmd+bracket-right": "Forward",
	"cmd+equal":         "Zoom in",
	"cmd+plus":          "Zoom in",
	"cmd+minus":         "Zoom out",
	"cmd+0":             "Reset zoom",
	"cmd+1":             "Conversation",
	"cmd+2":             "Files",
	"cmd+3":             "Agents",
	"cmd+z":             "Undo",
	"cmd+r":             "Reload",
	"ctrl+z":            "Undo",
	"cmd+alt+c":         "Copy GitHub PR URL",
	"cmd+shift+c":       "Copy PR Cockpit link",
	"1":                 "Saved view",
	"2":                 "Saved view",
	"3":                 "Saved view",
	"4":                 "Saved view",
	"5":                 "Saved view",
	"6":                 "Saved view",
	"7":                 "Saved view",
	"8":                 "Saved view",
	"9":                 "Saved view",
}

var analyticsKeySymbols = map[string]string{
	"cmd": "⌘", "ctrl": "⌃", "alt": "⌥", "shift": "⇧",
	"slash": "/", "question": "?", "comma": ",", "period": ".", "semicolon": ";", "quote": "'",
	"bracket-left": "[", "bracket-right": "]", "equal": "=", "plus": "+", "minus": "-",
	"enter": "↩", "escape": "Esc", "tab": "Tab", "space": "Space", "backspace": "⌫", "delete": "⌦",
	"up": "↑", "down": "↓", "left": "←", "right": "→", "home": "Home", "end": "End",
}

var analyticsScreenLabels = map[string]string{
	"inbox":        "Inbox",
	"github-setup": "GitHub setup",
	"home":         "Home page",
}

var analyticsScreenSections = map[string]string{
	"detail":     "PR",
	"settings":   "Settings",
	"onboarding": "Onboarding",
}

var analyticsValueLabels = map[string]string{
	"ok":             "succeeded",
	"failed":         "failed",
	"new":            "new install",
	"existing":       "existing install",
	"login":          "sign in",
	"refresh":        "refresh access",
	"manual":         "copied by hand",
	"install":        "installed",
	"update":         "updated",
	"request":        "requested",
	"missing-cli":    "GitHub CLI missing",
	"missing-auth":   "Not signed in to GitHub",
	"missing-scopes": "GitHub access scopes missing",
	"authorizing":    "Authorizing in the browser",
	"error":          "GitHub error",
}

var analyticsSurfaceLabels = map[string]string{
	"app":    "App",
	"site":   "Website",
	"script": "Install script",
}

var analyticsPlatformLabels = map[string]string{
	"darwin":  "macOS",
	"linux":   "Linux",
	"windows": "Windows",
	"other":   "Other",
	"":        "Unknown",
}

var analyticsAcronyms = map[string]string{
	"pr": "PR", "prs": "PRs", "ci": "CI", "cli": "CLI", "ui": "UI", "url": "URL", "api": "API",
	"faq": "FAQ", "github": "GitHub", "gh": "GH", "macos": "macOS", "id": "ID",
}

func analyticsLabel(kind, action string) string {
	switch kind {
	case "step":
		if label, ok := analyticsStepLabels[action]; ok {
			return label
		}
		if mutation, ok := strings.CutPrefix(action, "mutation:"); ok {
			if label, ok := analyticsMutationLabels[mutation]; ok {
				return label
			}
			return humanizeWords(mutation)
		}
	case "key":
		if label, ok := analyticsKeyLabels[action]; ok {
			return label
		}
		return keyCombo(action)
	case "screen":
		return screenLabel(action)
	case "cli":
		// CLIs from before command names arrive as their request, such as "get:pr" or "post:repo/runs".
		if method, route, ok := strings.Cut(action, ":"); ok {
			return "Older CLI · " + strings.ToUpper(method) + " " + strings.ReplaceAll(route, "/", " ")
		}
		return "pr-cockpit " + action
	}
	return humanizeName(action)
}

func analyticsValueLabel(value string) string {
	if label, ok := analyticsValueLabels[value]; ok {
		return label
	}
	return value
}

func screenLabel(name string) string {
	if label, ok := analyticsScreenLabels[name]; ok {
		return label
	}
	parts := strings.Split(name, "/")
	for index, part := range parts {
		if section, ok := analyticsScreenSections[part]; ok && index == 0 {
			parts[index] = section
		} else {
			parts[index] = humanizeWords(part)
		}
	}
	return strings.Join(parts, " · ")
}

// keyCombo renders a shortcut name such as "cmd+shift+c" as "⌘⇧C".
func keyCombo(action string) string {
	var combo strings.Builder
	for _, part := range strings.Split(action, "+") {
		if symbol, ok := analyticsKeySymbols[part]; ok {
			combo.WriteString(symbol)
		} else {
			combo.WriteString(strings.ToUpper(part))
		}
	}
	return combo.String()
}

// humanizeName turns "pr-header:merge" into "Merge · PR header": the most specific part first.
func humanizeName(name string) string {
	if host, ok := strings.CutPrefix(name, "out:"); ok {
		return "Link out · " + host
	}
	if page, ok := strings.CutPrefix(name, "to:"); ok {
		return "Link to " + screenLabel(page)
	}
	parts := strings.Split(name, ":")
	slices.Reverse(parts)
	for index, part := range parts {
		parts[index] = humanizeWords(part)
	}
	return strings.Join(parts, " · ")
}

func humanizeWords(part string) string {
	words := strings.FieldsFunc(part, func(r rune) bool { return r == '-' || r == '_' })
	for index, word := range words {
		if acronym, ok := analyticsAcronyms[word]; ok {
			words[index] = acronym
		} else if index == 0 {
			words[index] = strings.ToUpper(word[:1]) + word[1:]
		}
	}
	return strings.Join(words, " ")
}
