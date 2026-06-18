create table if not exists messages (
  event_key text primary key,
  chat_id text not null,
  chat_name text,
  channel_type integer,
  msg_id text,
  batch_id text,
  message_sn integer,
  sender_id integer,
  sender_name text,
  direction text not null,
  msg_type integer,
  content text,
  content2 text,
  teamplus_ts_ms integer,
  received_at_ms integer not null,
  raw_json text not null
);

create index if not exists messages_chat_time_idx
  on messages(chat_id, teamplus_ts_ms);

create index if not exists messages_sender_time_idx
  on messages(sender_id, teamplus_ts_ms);

create table if not exists session_events (
  id integer primary key autoincrement,
  account_id text not null,
  event_type text not null,
  detail text,
  created_at_ms integer not null
);

create index if not exists session_events_account_time_idx
  on session_events(account_id, created_at_ms);
