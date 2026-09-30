import { newSpecPage } from '@stencil/core/testing';
import type { ClassroomTabletState, CourseProject, LessonStep, ReceiptBook } from '../../models';
import { AppRoot } from './app-root';

/** 测试用句柄：绕过 TS 私有修饰，直接驱动组件内部方法 */
interface AppRootTestHandle {
  offline: boolean;
  activePanel: 'editor' | 'checks' | 'receipts';
  project: CourseProject;
  tablet: ClassroomTabletState;
  receiptBook: ReceiptBook;
  syncTablet(): void;
  toggleTabletStep(stepId: string): void;
  issueReceipt(): void;
  deliverReceipt(receiptId: string): void;
  updateStep(patch: Partial<LessonStep>): void;
  submitForReview(): void;
  freezeVersion(): void;
}

async function newStudioPage() {
  const page = await newSpecPage({ components: [AppRoot], html: '<app-root></app-root>' });
  return { page, app: page.rootInstance as unknown as AppRootTestHandle };
}

describe('app-root 课堂回执流程', () => {
  it('同步平板 → 签发回执 → 编排台对账并入台账', async () => {
    const { page, app } = await newStudioPage();
    app.offline = false;

    app.syncTablet();
    expect(app.tablet.steps.length).toBeGreaterThan(0);

    app.toggleTabletStep(app.tablet.steps[0].id);
    app.issueReceipt();
    await page.waitForChanges();

    expect(app.tablet.outbox[0].sendState).toBe('delivered');
    expect(app.tablet.outbox[0].ack).toBe('merged');
    expect(app.receiptBook.receipts).toHaveLength(1);
    const firstStepId = app.tablet.steps[0].id;
    expect(app.receiptBook.confirmations[firstStepId].completed).toBe(true);
    // 未勾选的步骤按“未跟完”入账
    const unchecked = app.tablet.steps[1].id;
    expect(app.receiptBook.confirmations[unchecked].completed).toBe(false);
  });

  it('回传失败后从课堂侧重试，重复送达只并入一次', async () => {
    const { app } = await newStudioPage();

    app.syncTablet();
    app.offline = true;
    app.issueReceipt();
    expect(app.tablet.outbox[0].sendState).toBe('failed');
    expect(app.receiptBook.receipts).toHaveLength(0);

    app.offline = false;
    app.deliverReceipt(app.tablet.outbox[0].id);
    expect(app.tablet.outbox[0].sendState).toBe('delivered');
    expect(app.receiptBook.receipts).toHaveLength(1);

    // 网络重试导致同一份回执重复送达：只并入一次
    app.deliverReceipt(app.tablet.outbox[0].id);
    expect(app.tablet.outbox[0].ack).toBe('duplicate');
    expect(app.receiptBook.receipts).toHaveLength(1);
  });

  it('步骤在回执签发后被改，回执作废且课程可照常编辑', async () => {
    const { page, app } = await newStudioPage();

    app.syncTablet();
    // 签发回执但暂不送达（模拟离线带回）
    app.offline = true;
    app.issueReceipt();
    const receiptId = app.tablet.outbox[0].id;
    app.offline = false;

    // 回执签发之后，编排台修改了某个步骤（updatedAt 晚于回执签发时间）
    const stepId = app.project.selectedStepId;
    app.updateStep({ caption: '回执签发后修改的字幕' });
    app.project = {
      ...app.project,
      modules: app.project.modules.map((module) => ({
        ...module,
        steps: module.steps.map((step) => step.id === stepId ? { ...step, updatedAt: '2099-01-01T00:00:00.000Z' } : step),
      })),
    };
    await page.waitForChanges();

    app.deliverReceipt(receiptId);
    expect(app.tablet.outbox[0].ack).toBe('voided');
    expect(app.receiptBook.receipts[0].status).toBe('voided');
    expect(Object.keys(app.receiptBook.confirmations)).toHaveLength(0);

    // 课程照常接着改：修改已生效且未被回执流程回滚
    const step = app.project.modules.flatMap((module) => module.steps).find((item) => item.id === stepId);
    expect(step?.caption).toBe('回执签发后修改的字幕');
  });

  it('课堂回执面板正常渲染台账、发件箱与冻结留档', async () => {
    const { page, app } = await newStudioPage();
    app.offline = false;

    app.syncTablet();
    app.issueReceipt();
    app.activePanel = 'receipts';
    await page.waitForChanges();

    const html = page.root?.innerHTML ?? '';
    expect(html).toContain('课堂端 · 教室平板 01');
    expect(html).toContain('对账台账（草稿）');
    expect(html).toContain('课堂端发件箱');
    expect(html).toContain('回执处理记录');
    expect(html).toContain('冻结版本留档');
    expect(html).toContain('未跟完');
  });

  it('冻结版本与草稿各留一份对账台账', async () => {
    const { page, app } = await newStudioPage();
    app.offline = false;

    app.syncTablet();
    app.issueReceipt();
    const mergedCount = Object.keys(app.receiptBook.confirmations).length;
    expect(mergedCount).toBeGreaterThan(0);

    // 修复演示数据里既有的字幕遮挡阻断问题，才能提交复核并冻结
    app.updateStep({ captionPosition: '下方安全区' });
    app.submitForReview();
    app.freezeVersion();
    await page.waitForChanges();

    expect(app.project.status).toBe('frozen');
    const frozen = app.project.frozenVersions[0];
    expect(Object.keys(frozen.receiptBook?.confirmations ?? {})).toHaveLength(mergedCount);
    expect(frozen.receiptBook?.receipts).toHaveLength(1);
    // 冻结留档是独立副本，与草稿互不影响
    expect(frozen.receiptBook).not.toBe(app.receiptBook);
  });
});
