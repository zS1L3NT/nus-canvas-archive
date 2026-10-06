import { assignmentDates } from "./archive-helpers.ts";
import { canvasDate } from "./lib.ts";
import type { CanvasTask, CourseData } from "./types.ts";

// Classic quizzes also appear as assignments; each quiz becomes one task carrying its assignment's overrides.
export function courseTasks(data: CourseData): CanvasTask[] {
  const code = data.configuredCourse.code;
  const quizIds = new Set(data.quizzes.map((quiz) => Number(quiz.id)));
  const quizAssignments = new Map(
    data.assignments
      .filter((assignment) => assignment.quiz_id && quizIds.has(Number(assignment.quiz_id)))
      .map((assignment) => [Number(assignment.quiz_id), assignment]),
  );
  const overrides = (assignmentId?: number) =>
    assignmentId === undefined
      ? []
      : assignmentDates({ due_at: null, unlock_at: null, lock_at: null }, data.assignmentOverrides[assignmentId]);
  const tasks: CanvasTask[] = [
    ...data.quizzes.map((quiz): CanvasTask => {
      const assignment = quizAssignments.get(Number(quiz.id));
      return {
        course: code,
        kind: "quiz",
        id: quiz.id,
        assignment_id: assignment?.id ?? null,
        title: quiz.title,
        url: quiz.html_url || "",
        due_at: canvasDate(quiz.due_at),
        unlock_at: canvasDate(quiz.unlock_at),
        lock_at: canvasDate(quiz.lock_at),
        overrides: overrides(assignment?.id),
        points: quiz.points_possible ?? null,
        submission_types: assignment?.submission_types || ["online_quiz"],
      };
    }),
    ...data.assignments
      .filter((assignment) => !assignment.quiz_id || !quizIds.has(Number(assignment.quiz_id)))
      .map(
        (assignment): CanvasTask => ({
          course: code,
          kind: "assignment",
          id: assignment.id,
          assignment_id: assignment.id,
          title: assignment.name,
          url: assignment.html_url || "",
          due_at: canvasDate(assignment.due_at),
          unlock_at: canvasDate(assignment.unlock_at),
          lock_at: canvasDate(assignment.lock_at),
          overrides: overrides(assignment.id),
          points: assignment.points_possible ?? null,
          submission_types: assignment.submission_types || [],
        }),
      ),
  ];
  return tasks.sort(
    (left, right) =>
      taskTime(left) - taskTime(right) || left.title.localeCompare(right.title, "en") || left.id - right.id,
  );
}

// A dated override replaces the course-wide date for the audience it targets.
export function effectiveDue(task: CanvasTask): string | null {
  return canvasDate(task.overrides.find((date) => canvasDate(date.due_at))?.due_at) ?? task.due_at;
}

function taskTime(task: CanvasTask): number {
  const due = effectiveDue(task);
  return due ? new Date(due).getTime() : Number.MAX_SAFE_INTEGER;
}
