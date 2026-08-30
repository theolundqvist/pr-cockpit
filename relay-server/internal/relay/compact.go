package relay

func compactActions(event string, payload webhookPayload) (*CompactRun, *CompactJob) {
	if event == "workflow_run" && payload.WorkflowRun != nil {
		run := payload.WorkflowRun
		attempt := run.RunAttempt
		if attempt == 0 {
			attempt = 1
		}
		workflowName := firstString(run.Name, run.WorkflowName)
		eventAt := firstString(run.UpdatedAt, run.RunStartedAt)
		var actorLogin *string
		if run.Actor != nil {
			actorLogin = run.Actor.Login
		}
		var prNumber *int64
		if len(run.PullRequests) > 0 {
			prNumber = &run.PullRequests[0].Number
		}
		runNumber := 0
		if run.RunNumber != nil {
			runNumber = *run.RunNumber
		}
		return &CompactRun{
			ID: run.ID, Attempt: attempt, HeadSHA: run.HeadSHA,
			HeadBranch: stringValue(run.HeadBranch), WorkflowName: workflowName,
			WorkflowPath: stringValue(run.Path), DisplayTitle: firstString(run.DisplayTitle, run.Name, run.WorkflowName),
			Event: stringValue(run.Event), ActorLogin: actorLogin, PRNumber: prNumber,
			Status: run.Status, Conclusion: run.Conclusion, EventAt: eventAt,
			CreatedAt: run.CreatedAt, UpdatedAt: run.UpdatedAt, RunStartedAt: run.RunStartedAt,
			RunNumber: runNumber, HTMLURL: run.HTMLURL,
		}, nil
	}
	if event == "workflow_job" && payload.WorkflowJob != nil {
		job := payload.WorkflowJob
		attempt := job.RunAttempt
		if attempt == 0 {
			attempt = 1
		}
		headSHA := stringValue(job.HeadSHA)
		headBranch := stringValue(job.HeadBranch)
		workflowName := stringValue(job.WorkflowName)
		if payload.WorkflowRun != nil {
			if headSHA == "" {
				headSHA = payload.WorkflowRun.HeadSHA
			}
			if headBranch == "" {
				headBranch = stringValue(payload.WorkflowRun.HeadBranch)
			}
			if workflowName == "" {
				workflowName = stringValue(payload.WorkflowRun.Name)
			}
		}
		labels := job.Labels
		if labels == nil {
			labels = []string{}
		}
		return nil, &CompactJob{
			ID: job.ID, RunID: job.RunID, Attempt: attempt, HeadSHA: headSHA,
			HeadBranch: headBranch, WorkflowName: workflowName, Name: job.Name,
			Status: job.Status, Conclusion: job.Conclusion, StartedAt: job.StartedAt,
			CompletedAt: job.CompletedAt, HTMLURL: job.HTMLURL, RunnerName: job.RunnerName,
			RunnerGroupName: job.RunnerGroupName, Labels: labels, FailedStep: failedStep(job.Steps),
		}
	}
	return nil, nil
}

func failedStep(steps []workflowStep) *string {
	for _, step := range steps {
		if step.Conclusion != nil && *step.Conclusion == "failure" {
			name := step.Name
			return &name
		}
	}
	return nil
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func firstString(values ...*string) string {
	for _, value := range values {
		if value != nil {
			return *value
		}
	}
	return ""
}

func pullNumber(payload webhookPayload) *int64 {
	if payload.PullRequest != nil {
		return &payload.PullRequest.Number
	}
	if payload.Issue != nil {
		return &payload.Issue.Number
	}
	if payload.CheckRun != nil && len(payload.CheckRun.PullRequests) > 0 {
		return &payload.CheckRun.PullRequests[0].Number
	}
	if payload.CheckSuite != nil && len(payload.CheckSuite.PullRequests) > 0 {
		return &payload.CheckSuite.PullRequests[0].Number
	}
	if payload.WorkflowRun != nil && len(payload.WorkflowRun.PullRequests) > 0 {
		return &payload.WorkflowRun.PullRequests[0].Number
	}
	if payload.WorkflowJob != nil && len(payload.WorkflowJob.PullRequests) > 0 {
		return &payload.WorkflowJob.PullRequests[0].Number
	}
	return nil
}
