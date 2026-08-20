import { describe, expect, test } from "bun:test";
import { presentMutationError } from "./mutationError.js";

describe("presentMutationError", () => {
  test("extracts a repository rule violation from a REST error", () => {
    const raw = 'RestRequestError: PUT /repos/example-org/webapp/pulls/6706/merge failed: 405 {"message":"Repository rule violations found\\n\\nA conversation must be resolved before this pull request can be merged.\\n\\n","documentation_url":"https://docs.github.com/rest/pulls/pulls#merge-a-pull-request","status":"405"}';

    expect(presentMutationError("merge", raw)).toEqual({
      title: "Merge blocked",
      message: "A conversation must be resolved before this pull request can be merged.",
      details: raw,
    });
  });

  test("keeps a concise REST failure message", () => {
    expect(presentMutationError("update branch", "RestRequestError: PUT /repos/acme/app failed: 409 Head branch was modified")).toEqual({
      title: "Update branch failed",
      message: "Head branch was modified.",
      details: "RestRequestError: PUT /repos/acme/app failed: 409 Head branch was modified",
    });
  });
  test("extracts GraphQL error messages", () => {
    const raw = 'GithubRequestError: GraphQL errors: [{\"type\":\"UNPROCESSABLE\",\"message\":\"Pull request is in unstable status\"}]';

    expect(presentMutationError("update branch", raw)).toEqual({
      title: "Update branch failed",
      message: "Pull request is in unstable status.",
      details: raw,
    });
  });

  test("does not infer a block from the request URL", () => {
    const raw = 'RestRequestError: PUT /repos/acme/conflict-resolver/pulls/9/merge failed: 500 {\"message\":\"Server Error\"}';

    expect(presentMutationError("merge", raw)).toEqual({
      title: "Merge failed",
      message: "Server Error.",
      details: raw,
    });
  });


  test("explains an interrupted request", () => {
    expect(presentMutationError("merge", "Error: interrupted")).toEqual({
      title: "Merge failed",
      message: "The request was interrupted.",
      details: "Error: interrupted",
    });
  });
});
