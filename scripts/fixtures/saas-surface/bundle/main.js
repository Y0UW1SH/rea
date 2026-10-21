// Synthetic client for the surface-coverage fixture. No real product is modeled.
import axios from "axios";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { gql } from "graphql-tag";

const API_PREFIX = "/api";

export async function listInvoices() {
  const response = await fetch("/api/invoices?page=1");
  return response.json();
}

export function createInvoice(invoice) {
  return axios.post("/api/invoices", invoice);
}

export function customer() {
  return fetch("https://app.example.test/api/customers/42");
}

export function archiveInvoice() {
  return fetch("https://app.example.test/api/invoices/archive", {
    method: "POST",
  });
}

export function reportStream() {
  return new EventSource("/api/reports/stream");
}

export function live() {
  return new WebSocket("/live");
}

export function metrics(payload) {
  return navigator.sendBeacon("/api/metrics", payload);
}

export function orders() {
  return fetch(API_PREFIX + "/orders");
}

export function title(translate) {
  return translate.get("invoices.title");
}

export const LIST_CUSTOMERS = gql`
  query ListCustomers($first: Int) {
    customers(first: $first) {
      id
      name
    }
  }
`;

export const RENAME_CUSTOMER = gql`
  mutation RenameCustomer($id: ID!, $name: String!) {
    renameCustomer(id: $id, name: $name) {
      id
    }
  }
`;

const trpc = createTRPCClient({
  links: [httpBatchLink({ url: "/trpc" })],
});

export function userById(id) {
  return trpc.user.byId.query({ id });
}

export function renameUser(input) {
  return trpc.user.rename.mutate(input);
}

export const routes = [
  { path: "/invoices", component: "InvoiceList" },
  { path: "/invoices/:id", component: "InvoiceDetail" },
  { path: "/settings", component: "Settings" },
];
