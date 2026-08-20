const studentNameCollator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true
});

export function sortStudentsByName(students) {
  return [...students].sort((left, right) => {
    const nameOrder = studentNameCollator.compare(
      String(left?.name ?? ""),
      String(right?.name ?? "")
    );

    if (nameOrder !== 0) return nameOrder;

    return studentNameCollator.compare(
      String(left?.id ?? ""),
      String(right?.id ?? "")
    );
  });
}
