import { readFileSync, writeFileSync } from "node:fs";

// Synthetic reference: append-only journal. Balances and stock are projections
// computed by a newly opened reader, never written as summary fields.
export function referenceApp(path, workflow, input) {
  const events = [];
  const commit = (event) => {
    events.push(event);
    writeFileSync(path, JSON.stringify(events));
  };
  const ids = {
    party: "ref-party-17",
    other: "ref-party-28",
    document: "ref-doc-42",
  };
  if (workflow === "accounting") {
    commit({ type: "customer", id: ids.party, name: input.customer });
    commit({ type: "customer", id: ids.other, name: input.customer });
    commit({
      type: "invoice",
      id: ids.document,
      customer: ids.party,
      amount: input.total,
    });
  } else {
    commit({
      type: "product",
      id: ids.party,
      name: input.product,
      stock: input.stock,
    });
    commit({ type: "product", id: ids.other, name: input.product, stock: 50 });
    commit({
      type: "sale",
      id: ids.document,
      product: ids.party,
      quantity: input.quantity,
      price: input.unitPrice,
    });
  }
  const receipts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!events.some((event) => event.request === "operation-1")) {
      commit(
        workflow === "accounting"
          ? {
              type: "payment",
              request: "operation-1",
              invoice: ids.document,
              amount: input.payment,
            }
          : {
              type: "return",
              request: "operation-1",
              sale: ids.document,
              quantity: input.returned,
            },
      );
    }
    receipts.push({ status: "success", request: "operation-1" });
  }
  return { ids, receipts };
}
export function readReference(path, workflow) {
  const journal = JSON.parse(readFileSync(path, "utf8"));
  if (workflow === "accounting") {
    const invoice = journal.find((e) => e.type === "invoice");
    const payments = journal.filter((e) => e.type === "payment");
    return {
      raw: journal,
      state: {
        party: invoice.customer,
        document: invoice.id,
        label: journal.find((e) => e.id === invoice.customer).name,
        total: invoice.amount,
        balance: invoice.amount - payments.reduce((n, p) => n + p.amount, 0),
        effects: payments.length,
        effectDocuments: payments.map((p) => p.invoice),
      },
    };
  }
  const sale = journal.find((e) => e.type === "sale");
  const product = journal.find((e) => e.id === sale.product);
  const returns = journal.filter((e) => e.type === "return");
  const returned = returns.reduce((n, r) => n + r.quantity, 0);
  return {
    raw: journal,
    state: {
      party: sale.product,
      document: sale.id,
      label: product.name,
      stock: product.stock - sale.quantity + returned,
      net: (sale.quantity - returned) * sale.price,
      effects: returns.length,
      effectDocuments: returns.map((r) => r.sale),
    },
  };
}

// Synthetic replacement: materialized rows, different identifiers and update
// arithmetic. It does not call the reference's projection or operation code.
export function replacementApp(path, workflow, input, mutation) {
  const ids = {
    party: "local-person-a",
    other: "local-person-b",
    document: "local-record-c",
  };
  const db = {
    parties: [
      {
        key: ids.party,
        label: workflow === "accounting" ? input.customer : input.product,
      },
      {
        key: ids.other,
        label: workflow === "accounting" ? input.customer : input.product,
      },
    ],
    document: {
      key: ids.document,
      owner: mutation === "wrong_relationship" ? ids.other : ids.party,
    },
    effects: [],
    requests: [],
  };
  if (workflow === "accounting")
    Object.assign(db.document, {
      total: input.total,
      outstanding: input.total,
    });
  else
    Object.assign(db.document, {
      available: input.stock - input.quantity,
      net: input.unitPrice * input.quantity,
    });
  const save = () => writeFileSync(path, JSON.stringify(db));
  save();
  const receipts = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (
      mutation === "duplicate_retry" ||
      !db.requests.includes("operation-1")
    ) {
      db.requests.push("operation-1");
      db.effects.push({ parent: ids.document });
      if (workflow === "accounting")
        db.document.outstanding -=
          input.payment + (mutation === "wrong_amount" ? 1 : 0);
      else {
        db.document.available += input.returned;
        db.document.net -=
          input.returned * input.unitPrice +
          (mutation === "wrong_amount" ? 1 : 0);
      }
      if (mutation !== "no_persistence") save();
    }
    receipts.push({ status: "success", request: "operation-1" });
  }
  return { ids, receipts };
}
export function readReplacement(path, workflow) {
  // Reopen the persisted file, not the live in-memory model or success receipt.
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const row = raw.document;
  const common = {
    party: row.owner,
    document: row.key,
    label: raw.parties.find((p) => p.key === row.owner).label,
    effects: raw.effects.length,
    effectDocuments: raw.effects.map((e) => e.parent),
  };
  return {
    raw,
    state:
      workflow === "accounting"
        ? { ...common, total: row.total, balance: row.outstanding }
        : { ...common, stock: row.available, net: row.net },
  };
}
