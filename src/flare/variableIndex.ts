import * as path from "node:path";
import { FlareProjectContext } from "../core/types";
import { resolveVariables } from "./variableResolver";

export interface VariableIndexEntry {
  /** Fully qualified name, e.g. `UI.ProductName`. */
  qualifiedName: string;
  /** The set prefix (filename of the `.flvar` without extension). */
  setName: string;
  /** Bare variable name (the `Name` attribute in the `.flvar`). */
  bareName: string;
  /** Resolved variable value. */
  value: string;
}

/**
 * Thin index over {@link resolveVariables}. The variable resolver already
 * walks every `.flvar` file declared by the project and caches a map keyed
 * by qualified + bare names. This index collapses that map into a
 * quick-pick-ready list of {@link VariableIndexEntry} rows, dropping the
 * bare-name duplicates so each variable appears exactly once.
 *
 * Consumers: the `flare.insertVariable` command, the `@@` bracket
 * completion provider, and the "Replace literal with variable" code action.
 */
export class VariableIndex {
  public async getEntries(projectContext: FlareProjectContext): Promise<VariableIndexEntry[]> {
    const resolved = await resolveVariables("", projectContext);
    const entries: VariableIndexEntry[] = [];
    for (const [name, value] of resolved.variables.entries()) {
      if (!name.includes(".")) {
        // Skip the bare-name duplicate — `resolveVariables` stores each
        // variable twice (once qualified, once bare) so the lookup for
        // `MadCap:variable name="Foo"` works the same as `Set.Foo`. We only
        // want one row per variable in the picker.
        continue;
      }
      const dotIndex = name.indexOf(".");
      entries.push({
        qualifiedName: name,
        setName: name.slice(0, dotIndex),
        bareName: name.slice(dotIndex + 1),
        value
      });
    }
    entries.sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
    return entries;
  }
}

/**
 * Looks for variables whose value equals the given literal (case-sensitive,
 * whitespace-trimmed). Returns every match so callers can decide whether to
 * auto-apply the single result or show a picker when there are several.
 */
export function findVariablesByValue(
  entries: readonly VariableIndexEntry[],
  literal: string
): VariableIndexEntry[] {
  const needle = literal.trim();
  if (needle.length === 0) {
    return [];
  }
  return entries.filter((entry) => entry.value.trim() === needle);
}

/**
 * Re-exports `path.basename`-style parsing of a `.flvar` file path into its
 * set name. Used by tests and by the index consumers that want to display
 * the source file in the docs panel without re-reading the file.
 */
export function setNameFromFlvarPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath));
}
