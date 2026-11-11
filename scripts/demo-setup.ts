import { PGlite } from "@electric-sql/pglite";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { hashPassword } from "../server/auth.js";

if (
  process.env.NODE_ENV === "production" ||
  process.env.DATA_SOURCE === "postgres"
)
  throw new Error("Demo setup cannot run in production or PostgreSQL mode.");
const path = resolve(process.env.DEMO_DB_PATH ?? ".data/demo-db");
await mkdir(dirname(path), { recursive: true });
const db = new PGlite(path);
await db.waitReady;
try {
  if (
    (await db.query("SELECT to_regclass('crm.users') AS name")).rows[0] &&
    (
      await db.query<{ name: string | null }>(
        "SELECT to_regclass('crm.users') AS name",
      )
    ).rows[0].name
  ) {
    console.log(
      "Existing demo database preserved. No data or passwords changed.",
    );
  } else {
    await db.exec(
      await readFile(
        new URL("../database/001_crm.sql", import.meta.url),
        "utf8",
      ),
    );
    const password = "SalesDemo2026!local";
    const hash = await hashPassword(password);
    const team = randomUUID(),
      otherTeam = randomUUID(),
      admin = randomUUID(),
      manager = randomUUID(),
      sales = randomUUID(),
      other = randomUUID();
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO crm.tenants(id,name) VALUES('szzhhq','中航环球 · 演示')",
      );
      await tx.query(
        "INSERT INTO crm.teams(id,tenant_id,name) VALUES($1,'szzhhq','深圳销售一组'),($2,'szzhhq','深圳销售二组')",
        [team, otherTeam],
      );
      for (const [id, username, displayName, role, teamId] of [
        [admin, "admin", "演示管理员", "admin", team],
        [manager, "manager", "演示主管", "manager", team],
        [sales, "sales", "小罗（演示）", "sales", team],
        [other, "sales2", "小陈（演示）", "sales", otherTeam],
      ]) {
        await tx.query(
          "INSERT INTO crm.users(id,tenant_id,team_id,username,display_name,role,password_hash,must_change_password) VALUES($1,'szzhhq',$2,$3,$4,$5,$6,false)",
          [id, teamId, username, displayName, role, hash],
        );
      }
      const names = [
        "汇康电子",
        "蓝海跨境",
        "远航供应链",
        "星辰科技",
        "华拓贸易",
        "森阳家居",
        "云帆电商",
        "新锐工业",
        "万顺物流",
        "天际智造",
        "晨曦用品",
        "海桥实业",
      ];
      const sources = [
        "call",
        "visit",
        "friend_referral",
        "customer_referral",
        "xiaohongshu",
        "douyin",
        "other_online",
      ];
      for (let i = 0; i < names.length; i++) {
        const id = randomUUID(),
          status = ["added", "opened", "shipped"][i % 3];
        await tx.query(
          "INSERT INTO crm.customers(id,tenant_id,owner_id,created_by,name,contact,phone,source,status,address,needs,note,high_intent,last_follow_at,next_follow_at,created_at) VALUES($1,'szzhhq',$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()-($12::int*interval '1 day'),now()+($13::int*interval '1 day'),now()-interval '30 days')",
          [
            id,
            sales,
            `示例·${names[i]}`,
            ["王经理", "陈女士", "李先生"][i % 3],
            `1380000${String(i).padStart(4, "0")}`,
            sources[i % sources.length],
            status,
            "深圳市 · 示例地址",
            i % 2 ? "欧美FBA头程拼箱" : "美线整柜FCL",
            "仅用于本地演示，不是真实客户",
            i % 4 === 0,
            i % 5,
            i === 0 ? -14 : (i % 5) - 2,
          ],
        );
        await tx.query(
          "INSERT INTO crm.follow_ups(tenant_id,customer_id,actor_id,action,content,occurred_at,reminder_action) VALUES('szzhhq',$1,$2,'greeting','示例沟通：了解近期出货计划与目的港需求。',now()-($3::int*interval '1 day'),'unchanged')",
          [id, sales, i % 5],
        );
      }
      const results = [
        "unanswered",
        "call_interested",
        "contact_added",
        "call_deferred",
        "contact_added",
      ];
      for (let i = 0; i < 5; i++)
        await tx.query(
          "INSERT INTO crm.activities(tenant_id,owner_id,type,customer_name,phone,result,next_judge,note,occurred_at) VALUES('szzhhq',$1,'call',$2,$3,$4,$5,$6,date_trunc('day',now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' + interval '9 hours'+($7::int*interval '20 minutes'))",
          [
            sales,
            `示例·${names[i]}`,
            `1390000${String(i).padStart(4, "0")}`,
            results[i],
            i === 3 ? "defer" : "revisit",
            "示例电销记录",
            i,
          ],
        );
      await tx.query(
        "INSERT INTO crm.activities(tenant_id,owner_id,type,customer_name,address,result,next_judge,note,occurred_at) VALUES('szzhhq',$1,'visit','示例·园区客户','深圳示例产业园A座','contact_added','revisit','昨日成功添加微信，可继续转客户',now()-interval '1 day')",
        [sales],
      );
    });
    console.log(
      "Synthetic demo ready. Accounts: sales, manager, admin, sales2. Password: SalesDemo2026!local",
    );
  }
} finally {
  await db.close();
}
