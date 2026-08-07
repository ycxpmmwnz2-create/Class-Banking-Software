const STUDENT_AUTH_OUTCOME_LABELS = Object.freeze({
  malformed_request: "Invalid request",
  invalid_code_or_login: "Invalid classroom code or login ID",
  throttled: "Too many attempts",
  invalid_credentials: "Invalid credentials",
  locked: "Account temporarily locked",
  success: "Authenticated"
});

export function formatStudentAuthLogTimestamp(timestamp) {
  let date = null;

  try {
    if (typeof timestamp?.toDate === "function") {
      date = timestamp.toDate();
    } else if (timestamp instanceof Date) {
      date = timestamp;
    } else if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      date = new Date(timestamp);
    }
  } catch {
    return "Unknown time";
  }

  return date instanceof Date && !Number.isNaN(date.getTime())
    ? date.toLocaleString()
    : "Unknown time";
}

export function studentAuthLogOutcomeLabel(log) {
  if (!log || typeof log !== "object") return "Unknown outcome";

  // Current V2 logs use `outcome`. Migrated legacy logs may retain `reason`.
  const outcome = typeof log.outcome === "string"
    ? log.outcome
    : (typeof log.reason === "string" ? log.reason : "");

  return STUDENT_AUTH_OUTCOME_LABELS[outcome] || "Unknown outcome";
}

export function studentAuthLogResultLabel(success) {
  if (success === true) return "Success";
  if (success === false) return "Failure";
  return "Unknown";
}

export function studentAuthLogStudentLabel(log, students) {
  const rawStudentId = log?.studentId;
  const studentId = (typeof rawStudentId === "string" || typeof rawStudentId === "number")
    ? String(rawStudentId).trim()
    : "";

  if (!studentId) return "Unknown student";

  const student = Array.isArray(students)
    ? students.find(candidate => String(candidate?.id) === studentId)
    : null;
  const studentName = typeof student?.name === "string" ? student.name.trim() : "";

  return studentName
    ? `${studentName} (ID ${studentId})`
    : `Student ID ${studentId}`;
}
