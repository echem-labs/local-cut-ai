import { Fragment } from "react";

import type { Project } from "../api/types";
import { plural, t } from "../i18n";
import { useApp } from "../store";

/**
 * The link between a script session and the video it became.
 *
 * Promotion has always created a second, unrelated project: the session sat
 * in the quick-tool list with nothing to say it had been used, and the video
 * had nothing to say where its screenplay came from. The engine records both
 * ids now; these render them.
 *
 * Both directions are ADVISORY. Either side can be deleted on its own and
 * the engine does not rewrite the survivor — that would mean reading every
 * meta on every delete — so an id is resolved against the live project list
 * and an unresolvable one renders nothing. A session the user deleted should
 * read as no link at all, never as a broken one.
 */
export function PromotedTo({ project }: { project: Project }) {
  const { projects, openProject } = useApp();
  const videos = (project.promoted_to ?? [])
    .map((id) => projects.find((entry) => entry.id === id))
    .filter((entry): entry is Project => Boolean(entry));
  if (videos.length === 0) return null;
  return (
    <p className="provenance" role="note">
      {plural("toolSession.becameVideo", videos.length)}{" "}
      {videos.map((video, index) => (
        <Fragment key={video.id}>
          {index > 0 && <span aria-hidden="true">, </span>}
          <button className="link" onClick={() => void openProject(video.id)}>
            {video.title}
          </button>
        </Fragment>
      ))}
    </p>
  );
}

export function PromotedFrom({ project }: { project: Project }) {
  const { projects, openProject } = useApp();
  const source = project.promoted_from
    ? projects.find((entry) => entry.id === project.promoted_from)
    : undefined;
  if (!source) return null;
  return (
    <p className="provenance" role="note">
      {t("project.fromSession")}{" "}
      <button className="link" onClick={() => void openProject(source.id)}>
        {source.title}
      </button>
    </p>
  );
}
