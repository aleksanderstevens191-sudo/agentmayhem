import { createFileRoute } from "@tanstack/react-router";

import { ProjectsHomePage } from "../components/projectsHome/ProjectsHomePage";

export const Route = createFileRoute("/_chat/overview")({
  validateSearch: (raw: Record<string, unknown>): { project?: string } =>
    typeof raw.project === "string" && raw.project.trim() ? { project: raw.project } : {},
  component: OverviewRoute,
});

function OverviewRoute() {
  const { project } = Route.useSearch();
  return <ProjectsHomePage selectedKey={project} />;
}
