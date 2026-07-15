import { setKV } from "../db.js";
import { updateEvent } from "../store.js";

export function isConfigured() {
  return Boolean(process.env.EVENTBRITE_TOKEN && process.env.EVENTBRITE_EVENT_ID);
}

export function status() {
  return { configured: isConfigured() };
}

export async function syncTickets() {
  if (!isConfigured()) throw new Error("Eventbrite is not configured. Set EVENTBRITE_TOKEN and EVENTBRITE_EVENT_ID.");
  const url = `https://www.eventbriteapi.com/v3/events/${encodeURIComponent(process.env.EVENTBRITE_EVENT_ID)}/ticket_classes/`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${process.env.EVENTBRITE_TOKEN}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || "Eventbrite request failed");
  const sold = (data.ticket_classes || []).reduce((sum, ticket) => sum + (ticket.quantity_sold || 0), 0);
  const event = updateEvent({ ticketsSold: sold });
  setKV("eventbriteLastSync", new Date().toISOString());
  return { ticketsSold: sold, ticketGoal: event.ticketGoal };
}
