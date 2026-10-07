const TABLE_IDS = [
  "11111111-1111-4111-8111-111111111101",
  "11111111-1111-4111-8111-111111111102",
  "11111111-1111-4111-8111-111111111103",
  "11111111-1111-4111-8111-111111111104",
  "11111111-1111-4111-8111-111111111105",
  "11111111-1111-4111-8111-111111111106",
  "11111111-1111-4111-8111-111111111107",
  "11111111-1111-4111-8111-111111111108",
  "11111111-1111-4111-8111-111111111109",
  "11111111-1111-4111-8111-111111111110",
  "11111111-1111-4111-8111-111111111111",
  "11111111-1111-4111-8111-111111111112",
];

function openedAt(minutesAgo) {
  return minutesAgo === null ? null : new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

export function createMockTables() {
  const definitions = [
    ["A01", 4, "AVAILABLE", null, null],
    ["A02", 2, "OCCUPIED", 2, 45],
    ["A03", 4, "BILLING", 4, 82],
    ["A04", 4, "PAID", null, null],
    ["A05", 6, "CLEANING", null, null],
    ["A06", 2, "RESERVED", null, null],
    ["A07", 4, "DELAYED", 3, 67],
    ["A08", 8, "MERGED", 6, 96],
    ["A09", 4, "AVAILABLE", null, null],
    ["A10", 2, "OCCUPIED", 2, 18],
    ["A11", 4, "AVAILABLE", null, null],
    ["A12", 4, "OCCUPIED", 4, 31],
  ];

  return definitions.map(([code, seats, status, guestCount, minutesAgo], index) => ({
    id: TABLE_IDS[index],
    code,
    seats,
    status,
    current_session_id: guestCount === null ? null : `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
    guest_count: guestCount,
    opened_at: openedAt(minutesAgo),
  }));
}

export const MOCK_OUTLET_ID = "33333333-3333-4333-8333-333333333333";
export const MOCK_STAFF_ID = "44444444-4444-4444-8444-444444444444";
