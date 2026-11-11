import { test as base, expect, type Page } from "@playwright/test";

// Exercise the built application with a disposable, synthetic database.
const test = base.extend<{ checkedPage: Page }>({
  checkedPage: async ({ page }, use) => {
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("response", (response) => {
      if (
        response.url().includes("/api/v1/") &&
        response.status() >= 400 &&
        !(response.url().endsWith("/auth/me") && response.status() === 401)
      ) {
        failures.push(
          `${response.status()} ${new URL(response.url()).pathname}`,
        );
      }
    });
    await use(page);
    expect(
      failures,
      "No uncaught browser errors or unexpected API failures",
    ).toEqual([]);
  },
});
const password = "SalesDemo2026!local";
async function login(page: Page, username = "sales", passwordValue = password) {
  await page.goto("/");
  await page.getByLabel("账号", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill(passwordValue);
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "工作台", exact: true }),
  ).toBeVisible();
}
async function navigate(page: Page, title: string) {
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("link", { name: new RegExp(title) })
    .click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}

test("客户建档、资料编辑、跟进、逐级晋级和归档形成闭环", async ({
  checkedPage: page,
}) => {
  await login(page);
  await expect(
    page.getByRole("heading", { name: "走货量待接入" }),
  ).toBeVisible();
  await navigate(page, "客户管理");
  await page.getByRole("button", { name: /新增客户$/ }).click();
  let drawer = page.getByRole("dialog");
  await drawer.getByLabel("客户名称", { exact: true }).fill("浏览器测试客户");
  await drawer.getByLabel("联系人", { exact: true }).fill("测试联系人");
  await drawer.getByLabel("联系电话", { exact: true }).fill("13800008881");
  await drawer.getByRole("button", { name: "保存客户" }).click();
  await expect(drawer.getByRole("button", { name: "编辑资料" })).toBeVisible();
  const detailUrl = page.url();
  await drawer.getByRole("button", { name: "编辑资料" }).click();
  await drawer
    .getByLabel("备注", { exact: true })
    .fill("验证编辑后原有客户资料仍保留");
  await drawer.getByRole("button", { name: "保存客户" }).click();
  await expect(
    drawer.getByText("验证编辑后原有客户资料仍保留", { exact: true }),
  ).toBeVisible();
  await drawer
    .getByLabel("跟进内容", { exact: true })
    .fill("已沟通海运报价，等待客户确认");
  await drawer.getByRole("button", { name: "添加跟进记录" }).click();
  await expect(
    drawer.locator(".timeline-entry").getByText("已沟通海运报价，等待客户确认"),
  ).toBeVisible();
  await drawer.getByRole("button", { name: "变更阶段" }).click();
  let modal = page.getByRole("dialog", { name: "确认客户阶段" });
  await modal.getByRole("button", { name: "确认变更" }).click();
  await expect(drawer.locator(".detail-badges .status-badge")).toHaveText(
    /已开户/,
  );
  await drawer
    .locator(".ant-radio-button-wrapper")
    .filter({ hasText: "客户下单" })
    .click();
  await drawer
    .getByLabel("跟进内容", { exact: true })
    .fill("实际走货已确认，记录首单");
  await drawer.getByRole("button", { name: "添加跟进记录" }).click();
  modal = page.getByRole("dialog", { name: "客户下单 · 更新阶段" });
  await modal.getByRole("button", { name: "升级并记录" }).click();
  await expect(drawer.locator(".detail-badges .status-badge")).toHaveText(
    /已走货/,
  );
  await page.reload();
  await expect(page.getByRole("dialog").locator(".timeline-entry")).toHaveCount(
    2,
  );
  drawer = page.getByRole("dialog");
  await drawer.getByRole("button", { name: /归\s*档$/ }).click();
  modal = page.getByRole("dialog", { name: "归档客户" });
  await modal.getByLabel("操作原因").fill("自动验收完成，归档测试客户");
  await modal.getByRole("button", { name: /确\s*认$/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("textbox", { name: "搜索客户", exact: true })
    .fill("浏览器测试客户");
  await expect(page.getByText("无匹配结果", { exact: true })).toBeVisible();
  // An archived customer's historical link remains readable to its owner.
  await page.goto(detailUrl);
  await expect(
    page.getByText("客户已归档，历史记录完整保留。恢复后可以继续跟进。"),
  ).toBeVisible();
});

test("沟通可重复录入，取消转化后可从历史继续，保存后才标记已转客户", async ({
  checkedPage: page,
}) => {
  await login(page);
  await navigate(page, "电销·扫楼");
  async function record() {
    await page
      .locator(".result-choices .ant-radio-button-wrapper")
      .filter({ hasText: "成功添加联系方式" })
      .click();
    await page.getByLabel("客户名称", { exact: true }).fill("待转化浏览器客户");
    await page.getByLabel("联系方式", { exact: true }).fill("13800008882");
    await page.getByRole("button", { name: "保存电销记录" }).click();
  }
  await record();
  await page
    .getByRole("dialog", { name: "成功添加联系方式" })
    .getByRole("button", { name: "稍后再说" })
    .click();
  await expect(
    page
      .locator(".today-records .activity-card")
      .filter({ hasText: "待转化浏览器客户" }),
  ).toHaveCount(1);
  await record();
  await page
    .getByRole("dialog", { name: "成功添加联系方式" })
    .getByRole("button", { name: "立即转客户" })
    .click();
  let drawer = page.getByRole("dialog");
  await expect(drawer.getByLabel("客户名称", { exact: true })).toHaveValue(
    "待转化浏览器客户",
  );
  await drawer.getByRole("button", { name: /取\s*消$/ }).click();
  await navigate(page, "电销记录");
  await page
    .getByRole("textbox", { name: "搜索电销记录" })
    .fill("待转化浏览器客户");
  const rows = page
    .locator(".desktop-table tbody tr")
    .filter({ hasText: "待转化浏览器客户" });
  await expect(rows).toHaveCount(2);
  await expect(
    rows.first().getByRole("button", { name: "转客户", exact: true }),
  ).toBeVisible();
  await rows
    .first()
    .getByRole("button", { name: "转客户", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存客户" })
    .click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "编辑资料" }),
  ).toBeVisible();
  await page.goto("/call-records");
  await page
    .getByRole("textbox", { name: "搜索电销记录" })
    .fill("待转化浏览器客户");
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "已转客户" })).toHaveCount(1);
  await rows
    .filter({ has: page.getByRole("button", { name: "转客户", exact: true }) })
    .getByRole("button", { name: "转客户", exact: true })
    .click();
  drawer = page.getByRole("dialog");
  await drawer
    .locator(".ant-radio-button-wrapper")
    .filter({ hasText: "关联已有客户" })
    .click();
  await drawer.getByRole("combobox").fill("待转化浏览器客户");
  await page
    .locator(".ant-select-item-option-content")
    .filter({ hasText: "待转化浏览器客户" })
    .click();
  await drawer.getByRole("button", { name: "确认关联" }).click();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "编辑资料" }),
  ).toBeVisible();
  await page.goto("/call-records");
  await page
    .getByRole("textbox", { name: "搜索电销记录" })
    .fill("待转化浏览器客户");
  await expect(rows.filter({ hasText: "已转客户" })).toHaveCount(2);
});

test("管理员可进入员工、团队、审计界面并切换公司数据范围", async ({
  checkedPage: page,
}) => {
  await login(page, "admin");
  await page.locator(".scope-bar .ant-select").first().click();
  await page
    .locator(".ant-select-item-option-content")
    .getByText("全公司", { exact: true })
    .click();
  await expect(
    page.locator(".dashboard-kpis .kpi-value").first(),
  ).not.toHaveText("0");
  for (const title of ["员工管理", "团队管理", "操作审计"]) {
    await navigate(page, title);
    await expect(page.locator(".ant-table-tbody")).toBeVisible();
  }
});

test("五种屏幕宽度可访问四个页面，手机卡片与未保存提示可用", async ({
  checkedPage: page,
}, testInfo) => {
  test.setTimeout(90000);
  await login(page);
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [path, title] of [
      ["/", "工作台"],
      ["/customers", "客户管理"],
      ["/leads", "电销·扫楼"],
      ["/call-records", "电销记录"],
    ]) {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { name: title, exact: true }),
      ).toBeVisible();
      await expect
        .poll(
          () =>
            page.evaluate(
              () => document.documentElement.scrollWidth - window.innerWidth,
            ),
          { message: `${path} at ${width}px has no page overflow` },
        )
        .toBeLessThanOrEqual(1);
      if (width < 768)
        await expect(
          page.getByRole("navigation", { name: "底部导航" }),
        ).toBeVisible();
      if ((width === 1440 || width === 390) && path === "/")
        await page.screenshot({
          path: testInfo.outputPath(`dashboard-${width}.png`),
          fullPage: true,
        });
    }
  }
  await page.goto("/customers");
  await expect(
    page.locator(".mobile-cards .customer-card").first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /新增客户$/ }).click();
  await page
    .getByRole("dialog")
    .getByLabel("客户名称", { exact: true })
    .fill("尚未保存的测试输入");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /取\s*消$/ })
    .click();
  const confirm = page.getByRole("dialog", { name: "放弃尚未保存的内容？" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "继续编辑" }).click();
  await expect(
    page.getByRole("dialog").getByLabel("客户名称", { exact: true }),
  ).toHaveValue("尚未保存的测试输入");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /取\s*消$/ })
    .click();
  await page
    .getByRole("dialog", { name: "放弃尚未保存的内容？" })
    .getByRole("button", { name: "放弃并离开" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("管理员创建团队和员工，临时账号必须改密后才能使用", async ({
  checkedPage: page,
}) => {
  await login(page, "admin");
  await navigate(page, "团队管理");
  await page.getByRole("button", { name: /新增团队$/ }).click();
  let dialog = page.getByRole("dialog", { name: "新增团队" });
  await dialog.getByLabel("团队名称", { exact: true }).fill("浏览器验收团队");
  await dialog.getByRole("button", { name: /保\s*存$/ }).click();
  await expect(
    page.getByRole("cell", { name: "浏览器验收团队", exact: true }),
  ).toBeVisible();
  await navigate(page, "员工管理");
  await page.getByRole("button", { name: /新增员工$/ }).click();
  dialog = page.getByRole("dialog", { name: "新增员工" });
  await dialog.getByLabel("登录账号", { exact: true }).fill("browser_member");
  await dialog.getByLabel("员工姓名", { exact: true }).fill("浏览器验收员工");
  await dialog
    .locator(".ant-form-item")
    .filter({ hasText: "所属团队" })
    .locator(".ant-select-selector")
    .click();
  await page
    .locator(".ant-select-item-option-content")
    .getByText("浏览器验收团队", { exact: true })
    .click();
  await dialog.getByRole("button", { name: "创建账号" }).click();
  dialog = page.getByRole("dialog", { name: "临时密码已生成" });
  const temporary = await dialog.locator("code").innerText();
  expect(temporary.length).toBeGreaterThanOrEqual(14);
  await dialog.getByRole("button", { name: "我已妥善记录" }).click();
  await page.locator(".user-chip").click();
  await page.getByRole("menuitem", { name: /退出登录/ }).click();
  await page.getByLabel("账号", { exact: true }).fill("browser_member");
  await page.getByLabel("密码", { exact: true }).fill(temporary);
  await page.getByRole("button", { name: "登录工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "首次登录，请设置新密码" }),
  ).toBeVisible();
  const permanent = "BrowserAcceptance2026!local";
  await page.getByLabel("当前密码", { exact: true }).fill(temporary);
  await page.getByLabel("新密码", { exact: true }).fill(permanent);
  await page.getByLabel("确认新密码", { exact: true }).fill(permanent);
  await page.getByRole("button", { name: "保存新密码" }).click();
  await expect(page.getByRole("button", { name: "登录工作台" })).toBeVisible();
  await login(page, "browser_member", permanent);
  await expect(
    page
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("link", { name: /员工管理/ }),
  ).toHaveCount(0);
  await expect(page.locator(".dashboard-kpis .kpi-value").first()).toHaveText(
    "0",
  );
});
