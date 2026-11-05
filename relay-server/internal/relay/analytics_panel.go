package relay

import (
	"bytes"
	"context"
	"fmt"
	"html/template"
	"net/http"
	"sort"
	"strconv"
	"time"
)

const analyticsGoal = 10_000

// analyticsInstallPopulation selects installs whose first launch as a new install happened at or
// after the bound millisecond timestamp.
const analyticsInstallPopulation = `
WITH pop AS (
  SELECT st.subject AS subject, st.first_ms AS first_ms, s.ref AS ref
  FROM analytics_steps st JOIN analytics_subjects s ON s.subject = st.subject
  WHERE st.step = 'first-launch' AND st.value = 'new' AND s.surface = 'app' AND st.first_ms >= ?
)
`

type analyticsPanel struct {
	GeneratedAt   string
	Days          int
	Weeks         int
	Cards         []panelCard
	Goal          panelGoal
	Charts        []panelChart
	Funnel        []panelFunnelGroup
	Unobserved    []string
	AccountFunnel []panelFunnelGroup
	AccountWeeks  panelTable
	Cohorts       []panelTable
	TopLists      []panelTable
	AuthDropoff   panelTable
	Dropoff       []panelValue
	Platforms     panelTable
	Versions      panelTable
}

type panelValue struct{ Label, Value string }

type panelCard struct {
	Title  string
	Values []panelValue
	Note   string
}

type panelGoal struct{ Accounts, Target, Percent, Width string }

type panelBar struct{ X, Y, Height, Title string }

type panelChart struct {
	Title, Max, First, Last string
	Empty                   bool
	Bars                    []panelBar
}

type panelFunnelRow struct {
	Step                           int
	Label, Note                    string
	Empty                          bool
	Count, Width, Percent, Dropped string
}

type panelFunnelGroup struct {
	Title, Note string
	Rows        []panelFunnelRow
}

type panelCell struct{ Text, Class, Alpha string }

type panelTable struct {
	Title, Note string
	Columns     []panelCell
	Rows        [][]panelCell
}

type funnelStage struct {
	label   string
	note    string
	count   int64
	prev    int64
	hasPrev bool
}

// journey is one install's or account's activity: the UTC day it started and its latest active day.
type journey struct {
	first      time.Time
	lastActive string
}

func (j journey) eligible(days int, today time.Time) bool {
	return !j.first.AddDate(0, 0, days).After(today)
}

func (j journey) activeAfter(days int) bool {
	return j.lastActive != "" && j.lastActive >= j.first.AddDate(0, 0, days).Format(time.DateOnly)
}

type installJourney struct {
	journey
	subject                        string
	signedIn, repos, relay, linked bool
	firstAuth                      string
}

func (s *Server) handleAnalyticsPanel(response http.ResponseWriter, request *http.Request) {
	days, ok := boundedQueryInt(response, request, "days", 30, 180)
	if !ok {
		return
	}
	weeks, ok := boundedQueryInt(response, request, "weeks", 12, 52)
	if !ok {
		return
	}
	panel, err := s.store.AnalyticsPanel(request.Context(), days, weeks, s.now())
	if err != nil {
		s.internalError(response, err)
		return
	}
	var page bytes.Buffer
	if err := analyticsTemplate.Execute(&page, panel); err != nil {
		s.internalError(response, err)
		return
	}
	response.Header().Set("Content-Type", "text/html; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'")
	response.Write(page.Bytes())
}

func boundedQueryInt(response http.ResponseWriter, request *http.Request, name string, fallback, maximum int) (int, bool) {
	if !request.URL.Query().Has(name) {
		return fallback, true
	}
	value, err := strconv.Atoi(request.URL.Query().Get(name))
	if err != nil || value < 1 || value > maximum {
		http.Error(response, fmt.Sprintf("%s must be between 1 and %d", name, maximum), http.StatusBadRequest)
		return 0, false
	}
	return value, true
}

func (s *Store) AnalyticsPanel(ctx context.Context, days, weeks int, now time.Time) (analyticsPanel, error) {
	now = now.UTC()
	today := utcDay(now)
	panel := analyticsPanel{GeneratedAt: now.Format("2006-01-02 15:04 UTC"), Days: days, Weeks: weeks}
	if err := s.panelHeadline(ctx, &panel, now); err != nil {
		return analyticsPanel{}, err
	}
	if err := s.panelCharts(ctx, &panel, today); err != nil {
		return analyticsPanel{}, err
	}
	installs, err := s.installJourneys(ctx, now.AddDate(0, 0, -7*weeks).UnixMilli())
	if err != nil {
		return analyticsPanel{}, err
	}
	if err := s.panelFunnel(ctx, &panel, installs, now); err != nil {
		return analyticsPanel{}, err
	}
	if err := s.panelAccounts(ctx, &panel, today); err != nil {
		return analyticsPanel{}, err
	}
	if err := s.panelInstallCohorts(ctx, &panel, installs, today); err != nil {
		return analyticsPanel{}, err
	}
	if err := s.panelTopLists(ctx, &panel, today); err != nil {
		return analyticsPanel{}, err
	}
	if err := s.panelDropoff(ctx, &panel, installs, now); err != nil {
		return analyticsPanel{}, err
	}
	if err := s.panelPlatforms(ctx, &panel, today); err != nil {
		return analyticsPanel{}, err
	}
	return panel, nil
}

func (s *Store) panelHeadline(ctx context.Context, panel *analyticsPanel, now time.Time) error {
	today := utcDay(now)
	spans := []int{1, 7, 30}
	accounts := make([]panelValue, len(spans))
	installs := make([]panelValue, len(spans))
	for index, span := range spans {
		label := "Today"
		if span > 1 {
			label = fmt.Sprintf("%d days", span)
		}
		from := today.AddDate(0, 0, 1-span).Format(time.DateOnly)
		var activeAccounts, activeInstalls int64
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT github_user_id) FROM usage_daily WHERE day >= ?`, from).Scan(&activeAccounts); err != nil {
			return err
		}
		if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(DISTINCT d.subject) FROM analytics_days d JOIN analytics_subjects s ON s.subject = d.subject
WHERE s.surface = 'app' AND d.day >= ?`, from).Scan(&activeInstalls); err != nil {
			return err
		}
		accounts[index] = panelValue{Label: label, Value: formatCount(activeAccounts)}
		installs[index] = panelValue{Label: label, Value: formatCount(activeInstalls)}
	}
	var newInstalls []panelValue
	for _, span := range []int{7, 30} {
		var count int64
		if err := s.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM analytics_steps st JOIN analytics_subjects s ON s.subject = st.subject
WHERE s.surface = 'app' AND st.step = 'first-launch' AND st.value = 'new' AND st.first_ms >= ?`, now.AddDate(0, 0, -span).UnixMilli()).Scan(&count); err != nil {
			return err
		}
		newInstalls = append(newInstalls, panelValue{Label: fmt.Sprintf("%d days", span), Value: formatCount(count)})
	}
	var seen int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(DISTINCT github_user_id) FROM usage_daily`).Scan(&seen); err != nil {
		return err
	}
	panel.Cards = []panelCard{
		{Title: "Active GitHub accounts", Values: accounts, Note: "Accounts that opened a relay session."},
		{Title: "Active installs", Values: installs, Note: "Installs that sent usage stats."},
		{Title: "New installs", Values: newInstalls, Note: "First launches of a new install."},
		{Title: "GitHub accounts seen", Values: []panelValue{{Label: "All retained history", Value: formatCount(seen)}}, Note: "The relay keeps 90 days of account history."},
	}
	panel.Goal = panelGoal{
		Accounts: formatCount(seen),
		Target:   formatCount(analyticsGoal),
		Percent:  formatPercent(seen, analyticsGoal),
		Width:    formatWidth(seen, analyticsGoal),
	}
	return nil
}

func (s *Store) panelCharts(ctx context.Context, panel *analyticsPanel, today time.Time) error {
	from := today.AddDate(0, 0, -29)
	accounts, err := s.dailyCounts(ctx, `SELECT day, COUNT(*) FROM usage_daily WHERE day >= ? GROUP BY day`, from)
	if err != nil {
		return err
	}
	installs, err := s.dailyCounts(ctx, `
SELECT d.day, COUNT(*) FROM analytics_days d JOIN analytics_subjects s ON s.subject = d.subject
WHERE s.surface = 'app' AND d.day >= ? GROUP BY d.day`, from)
	if err != nil {
		return err
	}
	panel.Charts = []panelChart{dailyChart("GitHub accounts", accounts, from), dailyChart("Installs", installs, from)}
	return nil
}

func (s *Store) dailyCounts(ctx context.Context, query string, from time.Time) (map[string]int64, error) {
	rows, err := s.db.QueryContext(ctx, query, from.Format(time.DateOnly))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := make(map[string]int64)
	for rows.Next() {
		var day string
		var count int64
		if err := rows.Scan(&day, &count); err != nil {
			return nil, err
		}
		counts[day] = count
	}
	return counts, rows.Err()
}

func dailyChart(title string, counts map[string]int64, from time.Time) panelChart {
	const days = 30
	var peak int64
	for offset := range days {
		peak = max(peak, counts[from.AddDate(0, 0, offset).Format(time.DateOnly)])
	}
	chart := panelChart{Title: title, Max: formatCount(peak), First: from.Format("Jan 2"), Last: from.AddDate(0, 0, days-1).Format("Jan 2"), Empty: peak == 0}
	for offset := range days {
		day := from.AddDate(0, 0, offset)
		count := counts[day.Format(time.DateOnly)]
		height := 0.0
		if peak > 0 {
			height = float64(count) / float64(peak) * 100
		}
		chart.Bars = append(chart.Bars, panelBar{
			X:      strconv.Itoa(offset*10 + 1),
			Y:      strconv.FormatFloat(100-height, 'f', 1, 64),
			Height: strconv.FormatFloat(height, 'f', 1, 64),
			Title:  fmt.Sprintf("%s: %s", day.Format("Mon Jan 2"), formatCount(count)),
		})
	}
	return chart
}

func (s *Store) installJourneys(ctx context.Context, sinceMS int64) ([]installJourney, error) {
	rows, err := s.db.QueryContext(ctx, analyticsInstallPopulation+`
SELECT p.subject, p.first_ms,
  EXISTS(SELECT 1 FROM analytics_steps x WHERE x.subject = p.subject AND x.step = 'signed-in'),
  EXISTS(SELECT 1 FROM analytics_steps x WHERE x.subject = p.subject AND x.step = 'repos-configured'),
  EXISTS(SELECT 1 FROM analytics_steps x WHERE x.subject = p.subject AND x.step = 'relay-connected'),
  p.ref IS NOT NULL AND EXISTS(SELECT 1 FROM analytics_subjects r WHERE r.subject = 'a:' || p.ref AND r.surface = 'script'),
  COALESCE((SELECT x.value FROM analytics_steps x WHERE x.subject = p.subject AND x.step = 'auth'), ''),
  COALESCE((SELECT MAX(d.day) FROM analytics_days d WHERE d.subject = p.subject), '')
FROM pop p
`, sinceMS)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var journeys []installJourney
	for rows.Next() {
		var install installJourney
		var firstMS int64
		if err := rows.Scan(&install.subject, &firstMS, &install.signedIn, &install.repos, &install.relay, &install.linked, &install.firstAuth, &install.lastActive); err != nil {
			return nil, err
		}
		install.first = utcDay(time.UnixMilli(firstMS))
		journeys = append(journeys, install)
	}
	return journeys, rows.Err()
}

func (s *Store) panelFunnel(ctx context.Context, panel *analyticsPanel, installs []installJourney, now time.Time) error {
	rows, err := s.db.QueryContext(ctx, `
SELECT s.surface, st.step, COUNT(*) FROM analytics_steps st JOIN analytics_subjects s ON s.subject = st.subject
WHERE s.surface IN ('site', 'script') AND s.first_ms >= ?
GROUP BY s.surface, st.step`, now.AddDate(0, 0, -7*panel.Weeks).UnixMilli())
	if err != nil {
		return err
	}
	defer rows.Close()
	reached := make(map[string]int64)
	for rows.Next() {
		var surface, step string
		var count int64
		if err := rows.Scan(&surface, &step, &count); err != nil {
			return err
		}
		reached[surface+":"+step] = count
	}
	if err := rows.Err(); err != nil {
		return err
	}
	visits, saw, copied := reached["site:visit"], reached["site:saw-install"], reached["site:copy-install"]
	started, finished := reached["script:script-start"], reached["script:script-done"]
	var launched, signedIn, repos, relay, linked int64
	journeys := make([]journey, len(installs))
	for index, install := range installs {
		journeys[index] = install.journey
		launched++
		signedIn += boolCount(install.signedIn)
		repos += boolCount(install.repos)
		relay += boolCount(install.relay)
		linked += boolCount(install.linked)
	}
	launchNote := "Aggregate ratio to finished script runs: an install has no per-person link to the script run."
	if linked > 0 {
		launchNote = fmt.Sprintf("Aggregate ratio to finished script runs; %s of these installs carry their script run's id.", formatCount(linked))
	}
	app := []funnelStage{
		{label: analyticsLabel("step", "first-launch"), note: launchNote, count: launched, prev: finished, hasPrev: true},
		{label: analyticsLabel("step", "signed-in"), count: signedIn, prev: launched, hasPrev: true},
		{label: analyticsLabel("step", "repos-configured"), count: repos, prev: signedIn, hasPrev: true},
		{label: analyticsLabel("step", "relay-connected"), count: relay, prev: repos, hasPrev: true},
	}
	app = append(app, retentionStages(journeys, func(index int) bool { return installs[index].relay }, utcDay(now))...)
	panel.Funnel = []panelFunnelGroup{
		funnelGroup("Website", "One id per browser tab.", 1, []funnelStage{
			{label: analyticsLabel("step", "visit"), count: visits},
			{label: analyticsLabel("step", "saw-install"), count: saw, prev: visits, hasPrev: true},
			{label: analyticsLabel("step", "copy-install"), count: copied, prev: saw, hasPrev: true},
		}),
		funnelGroup("Install script", "One id per script run.", 4, []funnelStage{
			{label: analyticsLabel("step", "script-start"), note: "Aggregate ratio to website copies: a script run has no per-person link to a browser tab.", count: started, prev: copied, hasPrev: true},
			{label: analyticsLabel("step", "script-done"), count: finished, prev: started, hasPrev: true},
		}),
		funnelGroup("App", "One id per install, counting installs first launched as new. Later stages count installs that reached the step.", 6, app),
	}
	panel.Unobserved = []string{
		"GitHub README and repository views, and clones: GitHub's traffic API keeps 14 days and the relay does not store it.",
		"Downloads of the bootstrap script from raw.githubusercontent.com.",
		"Installs with usage stats or the relay turned off.",
	}
	return nil
}

// retentionStages counts journeys active again on day 1+, 7+ and 30+ after their first day. Journeys
// too young for a stage are left out of both that stage and its previous-step denominator;
// reachedBefore reports whether journey index reached the stage before day 1+.
func retentionStages(journeys []journey, reachedBefore func(int) bool, today time.Time) []funnelStage {
	stages := make([]funnelStage, 0, 3)
	previous := 0
	for _, days := range []int{1, 7, 30} {
		stage := funnelStage{label: fmt.Sprintf("Active again on day %d+", days), hasPrev: true}
		var eligible int64
		for index, j := range journeys {
			if !j.eligible(days, today) {
				continue
			}
			eligible++
			stage.count += boolCount(j.activeAfter(days))
			if previous == 0 {
				stage.prev += boolCount(reachedBefore(index))
			} else {
				stage.prev += boolCount(j.activeAfter(previous))
			}
		}
		stage.note = formatCount(eligible) + " eligible"
		stages = append(stages, stage)
		previous = days
	}
	return stages
}

func funnelGroup(title, note string, firstStep int, stages []funnelStage) panelFunnelGroup {
	var peak int64
	for _, stage := range stages {
		peak = max(peak, stage.count)
	}
	group := panelFunnelGroup{Title: title, Note: note}
	for index, stage := range stages {
		row := panelFunnelRow{Step: firstStep + index, Label: stage.label, Note: stage.note, Empty: stage.count == 0, Count: formatCount(stage.count), Width: formatWidth(stage.count, peak)}
		if stage.hasPrev && stage.prev > 0 {
			row.Percent = formatPercent(stage.count, stage.prev)
			if stage.prev > stage.count {
				row.Dropped = formatCount(stage.prev - stage.count)
			}
		}
		group.Rows = append(group.Rows, row)
	}
	return group
}

func (s *Store) panelAccounts(ctx context.Context, panel *analyticsPanel, today time.Time) error {
	rows, err := s.db.QueryContext(ctx, `SELECT github_user_id, MIN(day), MAX(day) FROM usage_daily GROUP BY github_user_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	accounts := make(map[int64]journey)
	for rows.Next() {
		var id int64
		var first, last string
		if err := rows.Scan(&id, &first, &last); err != nil {
			return err
		}
		firstDay, err := time.Parse(time.DateOnly, first)
		if err != nil {
			return err
		}
		accounts[id] = journey{first: firstDay, lastActive: last}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	rows.Close()

	since := today.AddDate(0, 0, -7*panel.Weeks)
	var cohort []journey
	for _, account := range accounts {
		if !account.first.Before(since) {
			cohort = append(cohort, account)
		}
	}
	stages := append([]funnelStage{{label: "First seen", count: int64(len(cohort))}}, retentionStages(cohort, func(int) bool { return true }, today)...)
	panel.AccountFunnel = []panelFunnelGroup{funnelGroup("GitHub accounts", "Accounts whose first relay session was in the window. The relay keeps 90 days of sessions, so an account back after a longer gap counts as new.", 1, stages)}

	weekly := panelTable{
		Title:   "Accounts by first week",
		Note:    "Share of each week's new accounts active again, out of those old enough.",
		Columns: []panelCell{{Text: "Week of"}, {Text: "First seen", Class: "n"}, {Text: "Day 1+", Class: "n"}, {Text: "Day 7+", Class: "n"}, {Text: "Day 30+", Class: "n"}},
	}
	byWeek := make(map[time.Time][]journey)
	for _, account := range cohort {
		byWeek[monday(account.first)] = append(byWeek[monday(account.first)], account)
	}
	for week := monday(since); !week.After(today); week = week.AddDate(0, 0, 7) {
		members := byWeek[week]
		if len(members) == 0 {
			continue
		}
		row := []panelCell{{Text: week.Format("Jan 2")}, {Text: formatCount(int64(len(members))), Class: "n"}}
		for _, days := range []int{1, 7, 30} {
			var eligible, active int64
			for _, member := range members {
				if member.eligible(days, today) {
					eligible++
					active += boolCount(member.activeAfter(days))
				}
			}
			cell := panelCell{Text: "—", Class: "n dim"}
			if eligible > 0 {
				cell = panelCell{Text: fmt.Sprintf("%s · %s of %s", formatPercent(active, eligible), formatCount(active), formatCount(eligible)), Class: "n"}
			}
			row = append(row, cell)
		}
		weekly.Rows = append(weekly.Rows, row)
	}
	panel.AccountWeeks = weekly

	start := monday(today).AddDate(0, 0, -7*(panel.Weeks-1))
	grid := newCohortGrid(start, panel.Weeks)
	for _, account := range accounts {
		grid.join(account.first)
	}
	weeks, err := s.db.QueryContext(ctx, `SELECT DISTINCT github_user_id, date(day, '-6 days', 'weekday 1') FROM usage_daily WHERE day >= ?`, start.Format(time.DateOnly))
	if err != nil {
		return err
	}
	defer weeks.Close()
	for weeks.Next() {
		var id int64
		var week string
		if err := weeks.Scan(&id, &week); err != nil {
			return err
		}
		if err := grid.active(accounts[id].first, week); err != nil {
			return err
		}
	}
	if err := weeks.Err(); err != nil {
		return err
	}
	panel.Cohorts = append(panel.Cohorts, grid.table("GitHub accounts", "Accounts by the week of their first relay session in the 90 days the relay keeps; each cell is the share active in that week.", today))
	return nil
}

func (s *Store) panelInstallCohorts(ctx context.Context, panel *analyticsPanel, installs []installJourney, today time.Time) error {
	start := monday(today).AddDate(0, 0, -7*(panel.Weeks-1))
	grid := newCohortGrid(start, panel.Weeks)
	firsts := make(map[string]time.Time, len(installs))
	for _, install := range installs {
		firsts[install.subject] = install.first
		grid.join(install.first)
	}
	rows, err := s.db.QueryContext(ctx, analyticsInstallPopulation+`
SELECT DISTINCT d.subject, date(d.day, '-6 days', 'weekday 1')
FROM analytics_days d JOIN pop p ON p.subject = d.subject
WHERE d.day >= ?`, start.UnixMilli(), start.Format(time.DateOnly))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var subject, week string
		if err := rows.Scan(&subject, &week); err != nil {
			return err
		}
		if first, ok := firsts[subject]; ok {
			if err := grid.active(first, week); err != nil {
				return err
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	panel.Cohorts = append(panel.Cohorts, grid.table("Installs", "New installs by the week of their first launch; each cell is the share that sent usage stats in that week.", today))
	return nil
}

// cohortGrid counts members by the Monday of their first week and their activity by weeks since.
type cohortGrid struct {
	start time.Time
	sizes []int64
	hits  [][]int64
}

func newCohortGrid(start time.Time, weeks int) *cohortGrid {
	grid := &cohortGrid{start: start, sizes: make([]int64, weeks), hits: make([][]int64, weeks)}
	for index := range grid.hits {
		grid.hits[index] = make([]int64, weeks)
	}
	return grid
}

func (g *cohortGrid) index(day time.Time) int {
	return int(monday(day).Sub(g.start) / (7 * 24 * time.Hour))
}

func (g *cohortGrid) join(first time.Time) {
	if !first.Before(g.start) && g.index(first) < len(g.sizes) {
		g.sizes[g.index(first)]++
	}
}

func (g *cohortGrid) active(first time.Time, week string) error {
	activeWeek, err := time.Parse(time.DateOnly, week)
	if err != nil {
		return err
	}
	if first.Before(g.start) {
		return nil
	}
	cohort, offset := g.index(first), g.index(activeWeek)-g.index(first)
	if cohort < len(g.sizes) && offset >= 0 && offset < len(g.sizes) {
		g.hits[cohort][offset]++
	}
	return nil
}

func (g *cohortGrid) table(title, note string, today time.Time) panelTable {
	table := panelTable{Title: title, Note: note, Columns: []panelCell{{Text: "Week of"}, {Text: "People", Class: "n"}}}
	for offset := range g.sizes {
		table.Columns = append(table.Columns, panelCell{Text: fmt.Sprintf("W%d", offset), Class: "n"})
	}
	current := g.index(today)
	for cohort, size := range g.sizes {
		if size == 0 {
			continue
		}
		row := []panelCell{{Text: g.start.AddDate(0, 0, 7*cohort).Format("Jan 2")}, {Text: formatCount(size), Class: "n"}}
		for offset, hits := range g.hits[cohort] {
			if cohort+offset > current {
				row = append(row, panelCell{})
				continue
			}
			share := float64(hits) / float64(size)
			row = append(row, panelCell{Text: formatPercent(hits, size), Class: "n", Alpha: strconv.FormatFloat(0.08+0.72*share, 'f', 2, 64)})
		}
		table.Rows = append(table.Rows, row)
	}
	return table
}

func (s *Store) panelTopLists(ctx context.Context, panel *analyticsPanel, today time.Time) error {
	from := today.AddDate(0, 0, 1-panel.Days).Format(time.DateOnly)
	note := fmt.Sprintf("Last %d days, sorted by people.", panel.Days)
	for _, list := range []struct{ kind, title, detail string }{
		{"ui", "Features used", "Value"},
		{"key", "Keyboard shortcuts", "Keys"},
		{"step", "Outcomes", "Value"},
		{"cli", "CLI commands", "Result"},
		{"screen", "Screens", "Value"},
	} {
		rows, err := s.db.QueryContext(ctx, `
SELECT s.surface, c.action, c.value, SUM(c.n), COUNT(DISTINCT c.subject)
FROM analytics_counts c JOIN analytics_subjects s ON s.subject = c.subject
WHERE c.kind = ? AND c.day >= ?
GROUP BY s.surface, c.action, c.value
ORDER BY 5 DESC, 4 DESC, 1, 2, 3
LIMIT 40`, list.kind, from)
		if err != nil {
			return err
		}
		table := panelTable{Title: list.title, Note: note, Columns: []panelCell{{Text: "Name"}, {Text: list.detail}, {Text: "Where"}, {Text: "People", Class: "n"}, {Text: "Events", Class: "n"}}}
		for rows.Next() {
			var surface, action, value string
			var events, people int64
			if err := rows.Scan(&surface, &action, &value, &events, &people); err != nil {
				rows.Close()
				return err
			}
			detail := panelCell{Text: analyticsValueLabel(value), Class: "dim"}
			if list.kind == "key" {
				detail = panelCell{Text: keyCombo(action), Class: "key"}
			}
			table.Rows = append(table.Rows, []panelCell{
				{Text: analyticsLabel(list.kind, action)},
				detail,
				{Text: analyticsSurfaceLabels[surface], Class: "dim"},
				{Text: formatCount(people), Class: "n"},
				{Text: formatCount(events), Class: "n"},
			})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		panel.TopLists = append(panel.TopLists, table)
	}
	return nil
}

var authStateRank = map[string]int{"error": -1, "missing-cli": 0, "missing-auth": 1, "missing-scopes": 2, "authorizing": 3}

func (s *Store) panelDropoff(ctx context.Context, panel *analyticsPanel, installs []installJourney, now time.Time) error {
	type authState struct {
		value, day string
	}
	latest := make(map[string]authState)
	rows, err := s.db.QueryContext(ctx, analyticsInstallPopulation+`
SELECT c.subject, c.value, MAX(c.day)
FROM analytics_counts c JOIN pop p ON p.subject = c.subject
WHERE c.kind = 'step' AND c.action = 'auth' AND c.value != ''
GROUP BY c.subject, c.value`, now.AddDate(0, 0, -7*panel.Weeks).UnixMilli())
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var subject string
		var state authState
		if err := rows.Scan(&subject, &state.value, &state.day); err != nil {
			return err
		}
		current, seen := latest[subject]
		if !seen || state.day > current.day || (state.day == current.day && authStateRank[state.value] > authStateRank[current.value]) {
			latest[subject] = state
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	today := utcDay(now)
	byState := make(map[string]int64)
	var signedInOnly, connectedOnly int64
	for _, install := range installs {
		if !install.signedIn {
			state := latest[install.subject].value
			if state == "" {
				state = install.firstAuth
			}
			byState[state]++
		}
		if install.signedIn && !install.relay {
			signedInOnly++
		}
		if install.relay && install.eligible(1, today) && !install.activeAfter(1) {
			connectedOnly++
		}
	}
	states := make([]string, 0, len(byState))
	for state := range byState {
		states = append(states, state)
	}
	sort.Slice(states, func(i, j int) bool {
		if byState[states[i]] != byState[states[j]] {
			return byState[states[i]] > byState[states[j]]
		}
		return states[i] < states[j]
	})
	table := panelTable{
		Title:   "Launched but never signed in to GitHub",
		Note:    fmt.Sprintf("New installs first launched in the last %d weeks, by the last GitHub state they reached.", panel.Weeks),
		Columns: []panelCell{{Text: "Last GitHub state"}, {Text: "Installs", Class: "n"}},
	}
	for _, state := range states {
		label := "Never reached sign-in"
		if state != "" {
			label = analyticsValueLabel(state)
		}
		table.Rows = append(table.Rows, []panelCell{{Text: label}, {Text: formatCount(byState[state]), Class: "n"}})
	}
	panel.AuthDropoff = table
	panel.Dropoff = []panelValue{
		{Label: "Signed in but never connected to the relay", Value: formatCount(signedInOnly)},
		{Label: "Connected to the relay but never active again (first launch at least a day ago)", Value: formatCount(connectedOnly)},
	}
	return nil
}

func (s *Store) panelPlatforms(ctx context.Context, panel *analyticsPanel, today time.Time) error {
	from := today.AddDate(0, 0, 1-panel.Days).Format(time.DateOnly)
	note := fmt.Sprintf("Installs active in the last %d days.", panel.Days)
	for _, breakdown := range []struct {
		column string
		table  *panelTable
		title  string
	}{
		{"platform", &panel.Platforms, "Platforms"},
		{"version", &panel.Versions, "Versions"},
	} {
		rows, err := s.db.QueryContext(ctx, `
SELECT COALESCE(s.`+breakdown.column+`, ''), COUNT(*) FROM analytics_subjects s
WHERE s.surface = 'app' AND EXISTS(SELECT 1 FROM analytics_days d WHERE d.subject = s.subject AND d.day >= ?)
GROUP BY 1 ORDER BY 2 DESC, 1`, from)
		if err != nil {
			return err
		}
		*breakdown.table = panelTable{Title: breakdown.title, Note: note, Columns: []panelCell{{Text: breakdown.title[:len(breakdown.title)-1]}, {Text: "Installs", Class: "n"}}}
		for rows.Next() {
			var name string
			var count int64
			if err := rows.Scan(&name, &count); err != nil {
				rows.Close()
				return err
			}
			label := name
			if breakdown.column == "platform" {
				label = analyticsPlatformLabels[name]
			} else if name == "" {
				label = "Unknown"
			}
			breakdown.table.Rows = append(breakdown.table.Rows, []panelCell{{Text: label}, {Text: formatCount(count), Class: "n"}})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func utcDay(at time.Time) time.Time {
	at = at.UTC()
	return time.Date(at.Year(), at.Month(), at.Day(), 0, 0, 0, 0, time.UTC)
}

func monday(day time.Time) time.Time {
	return day.AddDate(0, 0, -((int(day.Weekday()) + 6) % 7))
}

func boolCount(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

func formatCount(value int64) string {
	digits := strconv.FormatInt(value, 10)
	if len(digits) <= 3 {
		return digits
	}
	var grouped []byte
	for index, digit := range []byte(digits) {
		if index > 0 && (len(digits)-index)%3 == 0 {
			grouped = append(grouped, ',')
		}
		grouped = append(grouped, digit)
	}
	return string(grouped)
}

func formatPercent(part, whole int64) string {
	share := float64(part) / float64(whole) * 100
	switch {
	case share > 0 && share < 1:
		return strconv.FormatFloat(share, 'f', 2, 64) + "%"
	case share > 0 && share < 10:
		return strconv.FormatFloat(share, 'f', 1, 64) + "%"
	}
	return strconv.FormatFloat(share, 'f', 0, 64) + "%"
}

func formatWidth(part, whole int64) string {
	if whole <= 0 {
		return "0"
	}
	return strconv.FormatFloat(min(float64(part)/float64(whole)*100, 100), 'f', 1, 64)
}

var analyticsTemplate = template.Must(template.New("analytics").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PR Cockpit analytics</title>
<style>
:root { color-scheme: dark; --bg: #0b0d10; --panel: #13161b; --line: #232830; --text: #e6e8eb; --muted: #8a929c; --accent: #4c8dff; --bad: #f0605d; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 32px 24px 80px; }
header { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 12px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin: 44px 0 12px; }
h3 { font-size: 14px; margin: 0; }
p { margin: 4px 0 0; }
.muted, .dim { color: var(--muted); }
.small { font-size: 12px; }
form { display: flex; gap: 14px; align-items: center; color: var(--muted); font-size: 12px; }
input { width: 60px; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 4px 6px; font: inherit; }
button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 5px 12px; font: inherit; cursor: pointer; }
.box { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; min-width: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.grid.wide { grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); }
.stack { display: grid; gap: 12px; }
.card h3 { color: var(--muted); font-weight: 500; font-size: 12px; }
.values { display: flex; gap: 20px; margin-top: 6px; }
.values b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
.values span { color: var(--muted); font-size: 12px; }
.goal { margin-top: 12px; }
.goal-head { display: flex; justify-content: space-between; margin-bottom: 8px; }
.bar { height: 10px; background: var(--line); border-radius: 5px; overflow: hidden; }
.bar i { display: block; height: 100%; min-width: 2px; background: var(--accent); border-radius: 5px; }
.chart { margin: 0; }
.chart figcaption, .axis { display: flex; justify-content: space-between; }
.chart svg { display: block; width: 100%; height: 96px; margin: 10px 0 6px; }
.chart rect { fill: var(--accent); }
.axis { font-size: 11px; }
.group { padding: 12px 0 4px; border-top: 1px solid var(--line); }
.group:first-child { border-top: 0; padding-top: 0; }
.stage { display: grid; grid-template-columns: 26px minmax(180px, 280px) 1fr 72px 90px 72px; gap: 14px; align-items: center; padding: 6px 0; }
.stage.head { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.stage .num { color: var(--muted); font-variant-numeric: tabular-nums; }
.stage small { display: block; color: var(--muted); font-size: 11px; line-height: 1.35; }
.stage .r { text-align: right; font-variant-numeric: tabular-nums; }
.stage .drop { color: var(--bad); }
.empty { color: var(--muted); font-style: italic; }
.stage .empty { grid-column: 3 / -1; }
.unobserved { margin-top: 12px; color: var(--muted); font-size: 13px; }
.unobserved ul { margin: 6px 0 0; padding-left: 18px; }
.scroll { overflow-x: auto; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--line); }
th, td.n { white-space: nowrap; }
.n { text-align: right; font-variant-numeric: tabular-nums; }
.key { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.list { margin: 12px 0 0; padding: 0; list-style: none; }
.list li { display: flex; justify-content: space-between; gap: 16px; padding: 6px 0; border-top: 1px solid var(--line); }
.list b { font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<main>
<header>
<div>
<h1>PR Cockpit analytics</h1>
<p class="muted small">Generated {{.GeneratedAt}}. Only names, counts and random ids are collected; no typed text, titles, paths or repository names.</p>
</div>
<form method="get" action="/analytics">
<label>Top lists <input type="number" name="days" min="1" max="180" value="{{.Days}}"> days</label>
<label>Funnel and cohorts <input type="number" name="weeks" min="1" max="52" value="{{.Weeks}}"> weeks</label>
<button type="submit">Apply</button>
</form>
</header>

<h2>Headline</h2>
<div class="grid">
{{range .Cards}}<div class="box card"><h3>{{.Title}}</h3><div class="values">{{range .Values}}<div><b>{{.Value}}</b><span>{{.Label}}</span></div>{{end}}</div>{{with .Note}}<p class="muted small">{{.}}</p>{{end}}</div>
{{end}}</div>
<div class="box goal">
<div class="goal-head"><span>Toward {{.Goal.Target}} users</span><span>{{.Goal.Accounts}} accounts · {{.Goal.Percent}}</span></div>
<div class="bar"><i style="width: {{.Goal.Width}}%"></i></div>
</div>

<h2>Daily actives · last 30 days</h2>
<div class="grid wide">
{{range .Charts}}<figure class="box chart">
<figcaption><span>{{.Title}}</span><span class="muted small">peak {{.Max}}</span></figcaption>
{{if .Empty}}<p class="empty">no data yet</p>{{else}}<svg viewBox="0 0 300 100" preserveAspectRatio="none" role="img">{{range .Bars}}<rect x="{{.X}}" y="{{.Y}}" width="8" height="{{.Height}}"><title>{{.Title}}</title></rect>{{end}}</svg>{{end}}
<div class="axis muted"><span>{{.First}}</span><span>{{.Last}}</span></div>
</figure>
{{end}}</div>

<h2>Funnel · first seen in the last {{.Weeks}} weeks</h2>
{{template "funnel" .Funnel}}
<div class="unobserved">Not observable here:<ul>{{range .Unobserved}}<li>{{.}}</li>{{end}}</ul></div>

<h2>GitHub accounts · first seen in the last {{.Weeks}} weeks</h2>
<div class="stack">
{{template "funnel" .AccountFunnel}}
{{template "table" .AccountWeeks}}
</div>

<h2>Retention by first week</h2>
<div class="stack">
{{range .Cohorts}}{{template "table" .}}{{end}}
</div>

<h2>Usage · last {{.Days}} days</h2>
<div class="grid wide">
{{range .TopLists}}{{template "table" .}}{{end}}
</div>

<h2>Drop-off</h2>
<div class="grid wide">
{{template "table" .AuthDropoff}}
<div class="box"><h3>Stalled installs</h3><p class="muted small">New installs first launched in the last {{.Weeks}} weeks.</p>
<ul class="list">{{range .Dropoff}}<li><span>{{.Label}}</span><b>{{.Value}}</b></li>{{end}}</ul></div>
</div>

<h2>Platforms and versions</h2>
<div class="grid wide">
{{template "table" .Platforms}}
{{template "table" .Versions}}
</div>
</main>
</body>
</html>
{{define "funnel"}}<div class="box">
<div class="stage head"><span></span><span>Stage</span><span></span><span class="r">People</span><span class="r">Of previous</span><span class="r">Dropped</span></div>
{{range .}}<div class="group"><h3>{{.Title}}</h3>{{with .Note}}<p class="muted small">{{.}}</p>{{end}}
{{range .Rows}}<div class="stage"><span class="num">{{.Step}}</span><div>{{.Label}}{{with .Note}}<small>{{.}}</small>{{end}}</div>
{{if .Empty}}<span class="empty">no data yet</span>{{else}}<div class="bar"><i style="width: {{.Width}}%"></i></div><b class="r">{{.Count}}</b><span class="r">{{or .Percent "—"}}</span><span class="r drop">{{with .Dropped}}−{{.}}{{end}}</span>{{end}}
</div>
{{end}}</div>
{{end}}</div>{{end}}
{{define "table"}}<div class="box">
<h3>{{.Title}}</h3>{{with .Note}}<p class="muted small">{{.}}</p>{{end}}
{{if .Rows}}<div class="scroll"><table>
<thead><tr>{{range .Columns}}<th{{with .Class}} class="{{.}}"{{end}}>{{.Text}}</th>{{end}}</tr></thead>
<tbody>{{range .Rows}}<tr>{{range .}}<td{{with .Class}} class="{{.}}"{{end}}{{with .Alpha}} style="background: rgba(76, 141, 255, {{.}})"{{end}}>{{.Text}}</td>{{end}}</tr>
{{end}}</tbody>
</table></div>{{else}}<p class="empty">no data yet</p>{{end}}
</div>{{end}}`))
