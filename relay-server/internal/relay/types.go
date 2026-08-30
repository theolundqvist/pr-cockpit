package relay

type CompactRun struct {
	ID           int64   `json:"id"`
	Attempt      int     `json:"attempt"`
	HeadSHA      string  `json:"headSha"`
	HeadBranch   string  `json:"headBranch"`
	WorkflowName string  `json:"workflowName"`
	WorkflowPath string  `json:"workflowPath"`
	DisplayTitle string  `json:"displayTitle"`
	Event        string  `json:"event"`
	ActorLogin   *string `json:"actorLogin"`
	PRNumber     *int64  `json:"prNumber"`
	Status       string  `json:"status"`
	Conclusion   *string `json:"conclusion"`
	EventAt      string  `json:"eventAt"`
	CreatedAt    *string `json:"createdAt"`
	UpdatedAt    *string `json:"updatedAt"`
	RunStartedAt *string `json:"runStartedAt"`
	RunNumber    int     `json:"runNumber"`
	HTMLURL      *string `json:"htmlUrl"`
}

type CompactJob struct {
	ID              int64    `json:"id"`
	RunID           int64    `json:"runId"`
	Attempt         int      `json:"attempt"`
	HeadSHA         string   `json:"headSha"`
	HeadBranch      string   `json:"headBranch"`
	WorkflowName    string   `json:"workflowName"`
	Name            string   `json:"name"`
	Status          string   `json:"status"`
	Conclusion      *string  `json:"conclusion"`
	StartedAt       *string  `json:"startedAt"`
	CompletedAt     *string  `json:"completedAt"`
	HTMLURL         *string  `json:"htmlUrl"`
	RunnerName      *string  `json:"runnerName"`
	RunnerGroupName *string  `json:"runnerGroupName"`
	Labels          []string `json:"labels"`
	FailedStep      *string  `json:"failedStep"`
}

type Marker struct {
	Seq    int64       `json:"seq"`
	TS     int64       `json:"ts"`
	Repo   string      `json:"repo"`
	Number *int64      `json:"number"`
	Event  string      `json:"event"`
	Run    *CompactRun `json:"run,omitempty"`
	Job    *CompactJob `json:"job,omitempty"`
}

type sessionRequest struct {
	Repos []string `json:"repos"`
}

type readyFrame struct {
	Type   string `json:"type"`
	Latest int64  `json:"latest"`
}

type markerFrame struct {
	Type   string `json:"type"`
	Marker Marker `json:"marker"`
}

type githubRepository struct {
	FullName string `json:"full_name"`
}

type pullReference struct {
	Number int64 `json:"number"`
}

type webhookPayload struct {
	Action              string             `json:"action"`
	Repository          *githubRepository  `json:"repository"`
	Repositories        []githubRepository `json:"repositories"`
	RepositoriesAdded   []githubRepository `json:"repositories_added"`
	RepositoriesRemoved []githubRepository `json:"repositories_removed"`
	Installation        *struct {
		RepositorySelection string `json:"repository_selection"`
		Account             *struct {
			Login string `json:"login"`
		} `json:"account"`
	} `json:"installation"`
	PullRequest *pullReference `json:"pull_request"`
	Issue       *pullReference `json:"issue"`
	CheckRun    *struct {
		PullRequests []pullReference `json:"pull_requests"`
	} `json:"check_run"`
	CheckSuite *struct {
		PullRequests []pullReference `json:"pull_requests"`
	} `json:"check_suite"`
	WorkflowRun *workflowRun `json:"workflow_run"`
	WorkflowJob *workflowJob `json:"workflow_job"`
}

type githubActor struct {
	Login *string `json:"login"`
}

type workflowRun struct {
	ID           int64           `json:"id"`
	RunAttempt   int             `json:"run_attempt"`
	HeadSHA      string          `json:"head_sha"`
	HeadBranch   *string         `json:"head_branch"`
	Name         *string         `json:"name"`
	WorkflowName *string         `json:"workflow_name"`
	Path         *string         `json:"path"`
	DisplayTitle *string         `json:"display_title"`
	Event        *string         `json:"event"`
	Actor        *githubActor    `json:"actor"`
	Status       string          `json:"status"`
	Conclusion   *string         `json:"conclusion"`
	CreatedAt    *string         `json:"created_at"`
	UpdatedAt    *string         `json:"updated_at"`
	RunStartedAt *string         `json:"run_started_at"`
	RunNumber    *int            `json:"run_number"`
	HTMLURL      *string         `json:"html_url"`
	PullRequests []pullReference `json:"pull_requests"`
}

type workflowJob struct {
	ID              int64           `json:"id"`
	RunID           int64           `json:"run_id"`
	RunAttempt      int             `json:"run_attempt"`
	HeadSHA         *string         `json:"head_sha"`
	HeadBranch      *string         `json:"head_branch"`
	WorkflowName    *string         `json:"workflow_name"`
	Name            string          `json:"name"`
	Status          string          `json:"status"`
	Conclusion      *string         `json:"conclusion"`
	StartedAt       *string         `json:"started_at"`
	CompletedAt     *string         `json:"completed_at"`
	HTMLURL         *string         `json:"html_url"`
	RunnerName      *string         `json:"runner_name"`
	RunnerGroupName *string         `json:"runner_group_name"`
	Labels          []string        `json:"labels"`
	Steps           []workflowStep  `json:"steps"`
	PullRequests    []pullReference `json:"pull_requests"`
}

type workflowStep struct {
	Name       string  `json:"name"`
	Conclusion *string `json:"conclusion"`
}
