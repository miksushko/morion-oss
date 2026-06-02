/**
 * AppleScript source for the two Apple Notes phases — folder probe and
 * full export. Kept verbatim so the AppleScript runtime semantics
 * (text-item-delimiters bulk replace, ISO 8601 date format, JSON
 * assembly) stay isolated from the TS spawner. Both scripts share the
 * `jsonEscape` / `replaceAll` / `dateToIso` helper definitions — the
 * O(n²) per-char-concat bug that hung imports on inline-base64 bodies
 * is fixed by using `text item delimiters` for an O(n) bulk replace.
 */

export const PROBE_SCRIPT = `
on run
  set output to "["
  set firstLine to true
  tell application "Notes"
    set accountList to every account
    repeat with acc in accountList
      set accName to name of acc
      set folderList to every folder of acc
      repeat with f in folderList
        set folderName to name of f
        set folderPath to folderName
        try
          set parentFolder to container of f
          if class of parentFolder is folder then
            set folderPath to (name of parentFolder) & "/" & folderName
          end if
        end try
        set nCount to count of (every note of f whose password protected is false)
        if firstLine then
          set firstLine to false
        else
          set output to output & ","
        end if
        set output to output & "{\\"account\\":\\"" & my jsonEscape(accName) & "\\",\\"folder\\":\\"" & my jsonEscape(folderName) & "\\",\\"path\\":\\"" & my jsonEscape(folderPath) & "\\",\\"count\\":" & nCount & "}"
      end repeat
    end repeat
  end tell
  set output to output & "]"
  return output
end run

on replaceAll(theText, oldStr, newStr)
  set d to AppleScript's text item delimiters
  set AppleScript's text item delimiters to oldStr
  set parts to text items of theText
  set AppleScript's text item delimiters to newStr
  set theText to parts as text
  set AppleScript's text item delimiters to d
  return theText
end replaceAll

on jsonEscape(s)
  -- O(n) bulk-replace via text item delimiters. Per-char concat
  -- (set out to out & ch in a repeat loop) is O(n^2) on AppleScript
  -- string size and hangs for minutes on Apple Notes bodies that
  -- carry inline base64 images (multi-MB strings). Backslash MUST
  -- be replaced first so subsequent escapes don't get double-escaped.
  set s to my replaceAll(s, "\\\\", "\\\\\\\\")
  set s to my replaceAll(s, quote, "\\\\" & quote)
  set s to my replaceAll(s, return, "\\\\r")
  set s to my replaceAll(s, linefeed, "\\\\n")
  set s to my replaceAll(s, tab, "\\\\t")
  return s
end jsonEscape
`;

/**
 * Builds an AppleScript that exports the body + metadata for every
 * note inside the selected (account, folderPath) tuples. The
 * generated script enumerates accounts/folders and emits one JSON
 * object per note delimited by a sentinel token that's safer than
 * newline (Apple Notes bodies contain newlines).
 *
 * Selected folders are passed as a flat list of strings
 * `account||path` so the script can do a string-equality check
 * against each folder's resolved path.
 */
export function buildExportScript(
  selected: Array<{ accountName: string; folderPath: string }>,
): string {
  const allowSet = selected
    .map((s) => `"${jsonEscapeAppleScript(s.accountName)}||${jsonEscapeAppleScript(s.folderPath)}"`)
    .join(', ');
  const allowList = selected.length > 0 ? `{${allowSet}}` : '{}';

  return `
on run
  set allowedFolders to ${allowList}
  set output to "["
  set firstNote to true
  set failCount to 0
  tell application "Notes"
    set accountList to every account
    repeat with acc in accountList
      set accName to name of acc
      set folderList to every folder of acc
      repeat with f in folderList
        set folderName to name of f
        set folderPath to folderName
        try
          set parentFolder to container of f
          if class of parentFolder is folder then
            set folderPath to (name of parentFolder) & "/" & folderName
          end if
        end try
        set folderKey to accName & "||" & folderPath
        if allowedFolders contains folderKey then
          set noteList to every note of f whose password protected is false
          repeat with n in noteList
            -- Build the JSON object into a local var FIRST. Only
            -- emit the comma + object together once the build
            -- succeeded — otherwise a property-access error mid-
            -- build leaves an orphan comma, producing output like
            -- "[,,,,,]" that breaks JSON.parse downstream.
            set jsonStr to ""
            try
              set nName to name of n
              set nBody to body of n
              set nCreated to creation date of n
              set nModified to modification date of n
              try
                set nPinned to pinned of n
              on error
                set nPinned to false
              end try
              -- Dates as ISO 8601 strings — sidesteps AppleScript's
              -- integer-overflow trap on epoch ms (1.7e12 doesn't
              -- fit reliably in AppleScript's integer type).
              set createdIso to my dateToIso(nCreated)
              set modifiedIso to my dateToIso(nModified)
              set pinnedJson to "false"
              if nPinned then set pinnedJson to "true"
              set jsonStr to "{"
              set jsonStr to jsonStr & "\\"account\\":\\"" & my jsonEscape(accName) & "\\","
              set jsonStr to jsonStr & "\\"folderPath\\":\\"" & my jsonEscape(folderPath) & "\\","
              set jsonStr to jsonStr & "\\"name\\":\\"" & my jsonEscape(nName) & "\\","
              set jsonStr to jsonStr & "\\"body\\":\\"" & my jsonEscape(nBody) & "\\","
              set jsonStr to jsonStr & "\\"createdAt\\":\\"" & createdIso & "\\","
              set jsonStr to jsonStr & "\\"modifiedAt\\":\\"" & modifiedIso & "\\","
              set jsonStr to jsonStr & "\\"pinned\\":" & pinnedJson
              set jsonStr to jsonStr & "}"
            on error errMsg
              -- Log to stderr so the Node side can surface it.
              -- Don't poison firstNote / output — just count and skip.
              set failCount to failCount + 1
              log "AppleScript: failed to read note (" & errMsg & ")"
              set jsonStr to ""
            end try
            if jsonStr is not "" then
              if firstNote then
                set firstNote to false
              else
                set output to output & ","
              end if
              set output to output & jsonStr
            end if
          end repeat
        end if
      end repeat
    end repeat
  end tell
  set output to output & "]"
  if failCount > 0 then
    log "AppleScript: " & failCount & " note(s) failed to read and were skipped"
  end if
  return output
end run

-- Format a date as a stable ISO 8601 string in local TZ. Node-side
-- Date.parse handles this reliably regardless of the host's locale.
on dateToIso(d)
  set y to year of d as string
  set mo to (month of d as integer) as string
  if length of mo is 1 then set mo to "0" & mo
  set dy to (day of d) as string
  if length of dy is 1 then set dy to "0" & dy
  set hr to (hours of d) as string
  if length of hr is 1 then set hr to "0" & hr
  set mn to (minutes of d) as string
  if length of mn is 1 then set mn to "0" & mn
  set sc to (seconds of d) as string
  if length of sc is 1 then set sc to "0" & sc
  return y & "-" & mo & "-" & dy & "T" & hr & ":" & mn & ":" & sc
end dateToIso

on replaceAll(theText, oldStr, newStr)
  set d to AppleScript's text item delimiters
  set AppleScript's text item delimiters to oldStr
  set parts to text items of theText
  set AppleScript's text item delimiters to newStr
  set theText to parts as text
  set AppleScript's text item delimiters to d
  return theText
end replaceAll

on jsonEscape(s)
  -- O(n) bulk-replace via text item delimiters. The previous per-
  -- char concat (set out to out & ch in a repeat loop) was O(n^2)
  -- on AppleScript string size — for an Apple Notes body carrying
  -- inline base64 images (a few MB of text), this hung at ~100% CPU
  -- for minutes-to-hours and was the root cause of the user-visible
  -- "import stuck at 0/0 imported" symptom on folders containing
  -- screenshots / photos. Backslash MUST be replaced first so the
  -- backslashes we INSERT don't get double-escaped.
  set s to my replaceAll(s, "\\\\", "\\\\\\\\")
  set s to my replaceAll(s, quote, "\\\\" & quote)
  set s to my replaceAll(s, return, "\\\\r")
  set s to my replaceAll(s, linefeed, "\\\\n")
  set s to my replaceAll(s, tab, "\\\\t")
  return s
end jsonEscape
`;
}

function jsonEscapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
