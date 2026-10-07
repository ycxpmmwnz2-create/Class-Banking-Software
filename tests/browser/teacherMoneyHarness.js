import { teacherAwardFixture } from '../phase3/teacherAward.fixture.js';
import { editTeacherProfileCallable } from '../../functions/phase3/teacherProfile.js';
import { getClassroomAccessService } from '../../functions/phase3/classroomAccess.js';
import { executeTeacherMoneyCallable, planTeacherMoneyCallable, recoverTeacherMoneyCallable } from '../../functions/phase3/teacherMoneyCallables.js';

// Browser bridge to the actual server services over fictional atomic storage.
// It creates no Firebase client and makes no provider or real-project request.
export async function attachTeacherMoneyHarness(page) {
  const rooms = new Map();
  await page.exposeFunction('__moneyTestServer', async ({ name, data, uid, classroomId }) => {
    const binding = JSON.stringify([uid, classroomId]);
    if (!rooms.has(binding)) {
      const f = teacherAwardFixture({ uid, classroomId });
      f.dependencies.projectId = 'demo-money-form';
      rooms.set(binding, f);
    }
    const f = rooms.get(binding), request = { auth: f.dependencies.auth, data };
    if (name === 'heavyClass') {
      for (let id = 1; id <= 30; id++) f.data.set(`classrooms/${classroomId}/students/${id}`, {
        id, name: `Fictional student ${id}`, balance: 20, frozen: false,
        transactions: Array.from({ length: 200 }, (_, i) => ({ id: id * 1000 + i, date: f.time,
          studentId: id, studentName: `Fictional student ${id}`, type: 'Add', amount: 1, reason: 'Homework',
          memo: '', category: 'Homework', status: 'Approved', source: 'Teacher' })),
      });
      return;
    }
    if (name === 'seedPending') {
      for (const [id, studentId] of [[11, 1], [12, 2]]) {
        const entry = { id, studentId, studentName: f.student(studentId).name, date: f.time,
          type: 'Add', amount: 3, status: 'Pending', source: 'Student', reason: 'Homework', memo: '', category: '' };
        f.data.set(`classrooms/${classroomId}/transactions/${id}`, entry);
        f.student(studentId).transactions.push(structuredClone(entry));
      }
      return;
    }
    if (name === 'editStudentProfileV2') return editTeacherProfileCallable(request, f.dependencies);
    if (name === 'load') return {
      students: [...f.data].filter(([path]) => path.startsWith(`classrooms/${classroomId}/students/`))
        .map(([, value]) => value).sort((a, b) => a.id - b.id),
      transactions: [...f.data].filter(([path]) => path.startsWith(`classrooms/${classroomId}/transactions/`)).map(([, value]) => value),
    };
    if (name === 'remove') { f.data.delete(`classrooms/${classroomId}/students/${data.studentId}`); return; }
    if (name === 'removeMoneyMetadata') {
      f.data.delete(f.paths.actor);
      f.data.delete(f.paths.quota);
      return;
    }
    if (name === 'getClassroomAccessV2') return getClassroomAccessService({ ...f.dependencies, data });
    if (name === 'planTeacherMoneyV2') return planTeacherMoneyCallable(request, f.dependencies);
    if (name === 'executeTeacherMoneyV2') return executeTeacherMoneyCallable(request, f.dependencies);
    const operation = { getTeacherMoneyStatusV2: 'status', acknowledgeTeacherMoneyV2: 'acknowledge', cancelTeacherMoneyV2: 'cancel' }[name];
    return recoverTeacherMoneyCallable(request, f.dependencies, operation);
  });
}
