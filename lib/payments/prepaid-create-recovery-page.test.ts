import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  receipt: null as null | { environment: string; status: string },
  flag: "false",
  allowed: true,
  enabled: true,
  environment: "TEST",
  invalid: false,
  configuration: vi.fn(),
  allowlist: vi.fn(),
  requireUser: vi.fn(),
  read: vi.fn(),
  target: vi.fn(),
}));
vi.mock("@/app/zentra-auth", () => ({
  requireZentraUser: fixture.requireUser,
}));
vi.mock("@/components/account/payment-receipt", () => ({
  PaymentReceipt: () => null,
}));
vi.mock("@/lib/payments/prepaid-receipt", () => ({
  ownedPrepaidReceipt: async () => fixture.receipt,
}));
vi.mock("@/lib/site-language-server", () => ({
  getSiteLanguage: async () => "de",
}));
vi.mock("@/lib/runtime", () => ({ runtimeValue: fixture.read, database: () => ({}) }));
vi.mock("@/lib/payments/postfinance-option", () => ({
  ownedPostFinanceInitialRecoveryTarget: fixture.target,
}));
vi.mock("@/lib/payments/postfinance-purchase-configuration", () => ({
  postFinancePurchaseConfiguration: fixture.configuration,
  postFinanceTestPurchaseAllowed: fixture.allowlist,
}));
import PaymentPage from "@/app/compte/paiement/page";
const purchaseId = "purchase_11111111-1111-4111-8111-111111111111";
const page = () => PaymentPage({ searchParams: Promise.resolve({ achat: purchaseId }) });
beforeEach(() => {
  vi.clearAllMocks();
  fixture.receipt = { environment: "TEST", status: "verification_required" };
  fixture.flag = "false";
  fixture.allowed = true;
  fixture.enabled = true;
  fixture.environment = "TEST";
  fixture.invalid = false;
  fixture.requireUser.mockResolvedValue({
    userId: "owner",
    emailConfirmed: true,
  });
  fixture.read.mockImplementation((name: string) =>
    name === "POSTFINANCE_CREATE_RECOVERY_ENABLED" ? fixture.flag : "",
  );
  fixture.configuration.mockImplementation(() => {
    if (fixture.invalid) throw new Error("Fictional unavailable private configuration.");
    return {
      enabled: fixture.enabled,
      connection: { prepaidEnvironment: fixture.environment },
    };
  });
  fixture.allowlist.mockImplementation(() => fixture.allowed);
  fixture.target.mockResolvedValue({
    period_id: "pfperiod_" + "a".repeat(64),
    transaction_id: null,
  });
});
describe("private recovery action visibility does not offer payment authority", () => {
  it("keeps the staged switch off without reading configuration", async () => {
    expect((await page()).props.canRecover).toBe(false);
    expect(fixture.configuration).not.toHaveBeenCalled();
    expect(fixture.requireUser).toHaveBeenCalledWith(expect.any(String), {
      offerAccess: false,
    });
  });
  it.each([null])("never loads merchant settings for environment %s", async (environment) => {
    fixture.flag = "true";
    fixture.receipt = environment ? { environment, status: "pending" } : null;
    expect((await page()).props.canRecover).toBe(false);
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.configuration).not.toHaveBeenCalled();
  });
  it("offers a PRODUCTION recovery action only for the same approved server environment and real target", async () => {
    fixture.flag = "true";
    fixture.receipt = { environment: "PRODUCTION", status: "pending" };
    fixture.environment = "PRODUCTION";
    expect((await page()).props.canRecover).toBe(true);
    expect(fixture.target).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ emailConfirmed: true }),
      purchaseId,
      "PRODUCTION",
      expect.any(Object),
    );
  });
  it.each(["pending", "verification_required"])(
    "hides %s when no exact server-scoped initial target exists",
    async (status) => {
      fixture.flag = "true";
      fixture.receipt = { environment: "TEST", status };
      fixture.target.mockResolvedValue(null);
      expect((await page()).props.canRecover).toBe(false);
    },
  );
  it.each(["active", "ended", "refunded", "not_completed", "test_confirmed", "activation_pending"])(
    "keeps the action hidden for %s",
    async (status) => {
      fixture.flag = "true";
      fixture.receipt!.status = status;
      expect((await page()).props.canRecover).toBe(false);
      expect(fixture.read).not.toHaveBeenCalled();
    },
  );
  it.each(["not-allowed", "off", "wrong-environment", "invalid-config"])(
    "fails closed for %s",
    async (mode) => {
      fixture.flag = "true";
      fixture.allowed = mode !== "not-allowed";
      fixture.enabled = mode !== "off";
      fixture.environment = mode === "wrong-environment" ? "PRODUCTION" : "TEST";
      fixture.invalid = mode === "invalid-config";
      expect((await page()).props.canRecover).toBe(false);
    },
  );
  it.each(["pending", "verification_required"])(
    "offers only an explicit action for allowlisted TEST %s",
    async (status) => {
      fixture.flag = "true";
      fixture.receipt!.status = status;
      const rendered = await page();
      expect(rendered.props).toMatchObject({
        canRecover: true,
        intentId: purchaseId,
        language: "de",
      });
      expect(fixture.allowlist).toHaveBeenCalledWith(expect.any(Object), "owner", fixture.read);
    },
  );
  it("does not read private settings before authentication succeeds", async () => {
    fixture.flag = "true";
    fixture.requireUser.mockRejectedValue(new Error("Sign-in required."));
    await expect(page()).rejects.toThrow("Sign-in required");
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.configuration).not.toHaveBeenCalled();
  });
});
