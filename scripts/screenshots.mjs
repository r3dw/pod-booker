// Screenshots of Pod Booker at phone and desktop sizes, signed in as a Clerk
// *test* user (dev instances only: emails containing "+clerk_test" sign in
// with the fixed code 424242 and no email is sent).
//
//   node scripts/screenshots.mjs [baseUrl] [outDir]
//   node scripts/screenshots.mjs http://localhost:3000 /tmp/shots
//
// Reads no env files; it only visits the given URL.
import { chromium, devices } from "playwright";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? "screenshots";
const email = process.env.PW_EMAIL ?? "pw+clerk_test@uchicago.edu";
const authFile = join(out, "auth.json");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();

async function signIn() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/sign-in`);
  await page.locator('input[name="identifier"]').fill(email);
  await page.getByRole("button", { name: /continue/i }).first().click();
  // Clerk shows a 6-digit code input (sign-in or sign-up, depending on whether the user exists).
  const otp = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[name^="codeInput"]').first();
  await otp.waitFor({ timeout: 20_000 });
  await otp.click();
  await page.keyboard.type("424242", { delay: 50 });
  await page.waitForURL((u) => !u.pathname.startsWith("/sign-in") && !u.pathname.includes("sign-up"), { timeout: 30_000 });
  await ctx.storageState({ path: authFile });
  await ctx.close();
  console.log("signed in as", email);
}

if (!existsSync(authFile)) await signIn();

const sizes = {
  phone: { ...devices["iPhone 13"] }, // 390 x 844, touch, mobile UA
  desktop: { viewport: { width: 1280, height: 900 } },
};

for (const [name, opts] of Object.entries(sizes)) {
  const ctx = await browser.newContext({ ...opts, storageState: authFile });
  const page = await ctx.newPage();
  const shot = (label) => page.screenshot({ path: join(out, `${name}-${label}.png`), fullPage: true });

  await page.goto(base);
  await page.getByText("My bookings").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500); // let bookings + live status settle
  await shot("1-calendar");

  // Open a booking dialog on the first free, bookable slot.
  const free = page.locator('button[aria-label$=" free"]').first();
  if (await free.count()) {
    await free.click();
    await page.getByRole("dialog").waitFor();
    await shot("2-dialog");
    await page.keyboard.press("Escape");
  } else {
    console.log(`${name}: no free slot on this day (closed or fully booked)`);
  }

  // Expand My bookings.
  await page.getByRole("button", { name: "My bookings" }).click();
  await page.waitForTimeout(500);
  await shot("3-my-bookings");

  await page.goto(`${base}/staff`);
  await page.waitForTimeout(1500);
  await shot("4-staff");
  await ctx.close();
}

await browser.close();
console.log("screenshots in", out);
