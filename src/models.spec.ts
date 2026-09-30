import { createDemoProject, emptyReceiptBook, reconcileReceipt, type LearningReceipt } from './models';

function makeReceipt(partial: Partial<LearningReceipt>): LearningReceipt {
  return {
    id: 'receipt-1',
    device: '教室平板 01',
    issuedAt: new Date().toISOString(),
    entries: [],
    ...partial,
  };
}

describe('reconcileReceipt 课堂回执对账', () => {
  it('按步骤编号并入当前课程，写入确认台账', () => {
    const project = createDemoProject();
    const receipt = makeReceipt({
      entries: [
        { stepId: 'step-1-1', title: '观察“你好”的完整动作', completed: true },
        { stepId: 'step-1-2', title: '拆解“你好”的手形', completed: false },
      ],
    });
    const result = reconcileReceipt(project, emptyReceiptBook(), receipt, new Date().toISOString());
    expect(result.kind).toBe('merged');
    expect(Object.keys(result.book.confirmations)).toHaveLength(2);
    expect(result.book.confirmations['step-1-1'].completed).toBe(true);
    expect(result.book.confirmations['step-1-2'].completed).toBe(false);
    expect(result.book.receipts[0].status).toBe('merged');
  });

  it('步骤在回执签发之后被改过，整份回执作废且不入台账', () => {
    const project = createDemoProject();
    // 所有步骤在 07:00 定稿，回执 08:00 签发
    project.modules.forEach((module) => module.steps.forEach((step) => { step.updatedAt = '2026-09-30T07:00:00.000Z'; }));
    const receipt = makeReceipt({
      id: 'receipt-stale',
      issuedAt: '2026-09-30T08:00:00.000Z',
      entries: [
        { stepId: 'step-1-1', title: '观察“你好”的完整动作', completed: true },
        { stepId: 'step-2-1', title: '数字一到五的稳定手形', completed: true },
      ],
    });
    // 回执签发之后，编排台在 09:00 修改了 step-1-1
    project.modules[0].steps[0].updatedAt = '2026-09-30T09:00:00.000Z';

    const result = reconcileReceipt(project, emptyReceiptBook(), receipt, new Date().toISOString());
    expect(result.kind).toBe('voided');
    expect(Object.keys(result.book.confirmations)).toHaveLength(0);
    const processed = result.book.receipts[0];
    expect(processed.status).toBe('voided');
    expect(processed.entries.find((entry) => entry.stepId === 'step-1-1')?.outcome).toBe('voided-stale');
    expect(processed.entries.find((entry) => entry.stepId === 'step-2-1')?.outcome).toBe('voided');
  });

  it('同一份回执重复送来只并入一次', () => {
    const project = createDemoProject();
    const receipt = makeReceipt({
      entries: [{ stepId: 'step-1-1', title: '观察“你好”的完整动作', completed: true }],
    });
    const first = reconcileReceipt(project, emptyReceiptBook(), receipt, new Date().toISOString());
    expect(first.kind).toBe('merged');

    const second = reconcileReceipt(project, first.book, receipt, new Date().toISOString());
    expect(second.kind).toBe('duplicate');
    expect(second.book).toBe(first.book);
    expect(second.book.receipts).toHaveLength(1);
    expect(Object.keys(second.book.confirmations)).toHaveLength(1);
  });

  it('回传失败重试时，已经对上的步骤保持不动', () => {
    const project = createDemoProject();
    const first = reconcileReceipt(
      project,
      emptyReceiptBook(),
      makeReceipt({
        id: 'receipt-a',
        entries: [{ stepId: 'step-1-1', title: '观察“你好”的完整动作', completed: false }],
      }),
      '2026-09-30T10:00:00.000Z',
    );
    expect(first.kind).toBe('merged');

    // 课堂侧再次送来新回执，同一步骤这次标记为已完成
    const second = reconcileReceipt(
      project,
      first.book,
      makeReceipt({
        id: 'receipt-b',
        entries: [
          { stepId: 'step-1-1', title: '观察“你好”的完整动作', completed: true },
          { stepId: 'step-1-2', title: '拆解“你好”的手形', completed: true },
        ],
      }),
      '2026-09-30T11:00:00.000Z',
    );
    expect(second.kind).toBe('merged');
    // 已对上的 step-1-1 保持第一次的记录不动
    expect(second.book.confirmations['step-1-1'].completed).toBe(false);
    expect(second.book.confirmations['step-1-1'].receiptId).toBe('receipt-a');
    expect(second.book.confirmations['step-1-2'].completed).toBe(true);
    const entries = second.kind === 'merged' ? second.receipt.entries : [];
    expect(entries.find((entry) => entry.stepId === 'step-1-1')?.outcome).toBe('already-confirmed');
    expect(entries.find((entry) => entry.stepId === 'step-1-2')?.outcome).toBe('confirmed');
  });

  it('步骤编号在当前课程里不存在时跳过该条，其余照常并入', () => {
    const project = createDemoProject();
    const receipt = makeReceipt({
      entries: [
        { stepId: 'step-removed', title: '已删除的步骤', completed: true },
        { stepId: 'step-1-1', title: '观察“你好”的完整动作', completed: true },
      ],
    });
    const result = reconcileReceipt(project, emptyReceiptBook(), receipt, new Date().toISOString());
    expect(result.kind).toBe('merged');
    expect(Object.keys(result.book.confirmations)).toEqual(['step-1-1']);
    const entries = result.kind === 'merged' ? result.receipt.entries : [];
    expect(entries.find((entry) => entry.stepId === 'step-removed')?.outcome).toBe('missing-step');
  });
});
