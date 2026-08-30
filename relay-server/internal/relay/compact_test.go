package relay

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestCompactWorkflowRunMatchesConsumerPayloadShape(t *testing.T) {
	body := []byte(`{"workflow_run":{"id":4,"run_attempt":2,"head_sha":"sha","head_branch":"main","name":"CI","path":".github/workflows/ci.yml","display_title":"CI for change","event":"pull_request","actor":{"login":"octocat"},"pull_requests":[{"number":42}],"status":"completed","conclusion":"success","created_at":"2026-08-30T09:58:00Z","updated_at":"2026-08-30T10:00:00Z","run_started_at":"2026-08-30T09:59:00Z","run_number":17,"html_url":"https://example.test/run"}}`)
	var payload webhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	run, _ := compactActions("workflow_run", payload)
	encoded, err := json.Marshal(run)
	if err != nil {
		t.Fatal(err)
	}
	var actual map[string]any
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	expected := map[string]any{
		"id": float64(4), "attempt": float64(2), "headSha": "sha", "headBranch": "main",
		"workflowName": "CI", "workflowPath": ".github/workflows/ci.yml", "displayTitle": "CI for change",
		"event": "pull_request", "actorLogin": "octocat", "prNumber": float64(42),
		"status": "completed", "conclusion": "success", "eventAt": "2026-08-30T10:00:00Z",
		"createdAt": "2026-08-30T09:58:00Z", "updatedAt": "2026-08-30T10:00:00Z",
		"runStartedAt": "2026-08-30T09:59:00Z", "runNumber": float64(17),
		"htmlUrl": "https://example.test/run",
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("compact run = %#v", actual)
	}
}

func TestCompactWorkflowJobMatchesPollingPayloadShape(t *testing.T) {
	body := []byte(`{
		"workflow_run":{"head_sha":"fallback-sha","head_branch":"fallback-branch","name":"Fallback Workflow"},
		"workflow_job":{"id":12,"run_id":8,"run_attempt":2,"name":"test","status":"completed","conclusion":"failure","started_at":"2026-08-30T10:00:00Z","completed_at":"2026-08-30T10:01:00Z","html_url":"https://example.test/job","runner_name":"runner","runner_group_name":"group","labels":["self-hosted"],"steps":[{"name":"checkout","conclusion":"success"},{"name":"tests","conclusion":"failure"}]}
	}`)
	var payload webhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	_, job := compactActions("workflow_job", payload)
	encoded, err := json.Marshal(job)
	if err != nil {
		t.Fatal(err)
	}
	var actual map[string]any
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	expected := map[string]any{
		"id": float64(12), "runId": float64(8), "attempt": float64(2),
		"headSha": "fallback-sha", "headBranch": "fallback-branch", "workflowName": "Fallback Workflow",
		"name": "test", "status": "completed", "conclusion": "failure",
		"startedAt": "2026-08-30T10:00:00Z", "completedAt": "2026-08-30T10:01:00Z",
		"htmlUrl": "https://example.test/job", "runnerName": "runner", "runnerGroupName": "group",
		"labels": []any{"self-hosted"}, "failedStep": "tests",
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("compact job = %#v", actual)
	}
}
