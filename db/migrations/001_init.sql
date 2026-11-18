-- Québec property assessment roll ("rôle d'évaluation foncière") — initial schema.
-- Field codes (RLxxxx) refer to the official "Répertoire des renseignements prescrits".

CREATE TABLE municipality (
  code text PRIMARY KEY,               -- RLM01A, e.g. '43027'
  name text                            -- from the official index CSV (--index option); NULL if not given
);

-- One row per attempt to import one file. This is the audit log.
CREATE TABLE import_run (
  id                bigserial PRIMARY KEY,
  file_name         text NOT NULL,
  file_sha256       char(64) NOT NULL,  -- file fingerprint: same content => same hash
  municipality_code text,
  roll_year         smallint,           -- from RLM02A (the file name can be wrong)
  xml_version       text,               -- VERSION, varies between files (2.8, 2.9...)
  status            text NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
  units_read        integer NOT NULL DEFAULT 0,
  units_loaded      integer NOT NULL DEFAULT 0,
  units_rejected    integer NOT NULL DEFAULT 0,
  error_message     text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz
);

-- One row per property rejected during an import (the file import continues).
CREATE TABLE import_error (
  id            bigserial PRIMARY KEY,
  import_run_id bigint NOT NULL REFERENCES import_run (id) ON DELETE CASCADE,
  unit_position integer NOT NULL,      -- 1 = first <RLUEx> in the file
  matricule     text,
  field         text,
  message       text NOT NULL
);

-- One row per property (unité d'évaluation) per roll.
-- Only the most useful fields are typed columns; the full original unit is kept in `raw`.
CREATE TABLE property_unit (
  id                     bigserial PRIMARY KEY,
  municipality_code      text NOT NULL REFERENCES municipality (code),
  roll_year              smallint NOT NULL,          -- RLM02A
  matricule              text NOT NULL,              -- RL0104A-B-C-D-E-F joined with '-'
  borough_code           text,                       -- RL0102A
  usage_code             text NOT NULL,              -- RL0105A (CUBF code)
  file_number            text,                       -- RL0106A
  neighborhood_unit      text,                       -- RL0107A
  frontage               numeric(8, 2),              -- RL0301A
  land_area              numeric(15, 2),             -- RL0302A
  agricultural_zone_code text NOT NULL,              -- RL0303A (0, 1, 2)
  max_floors             smallint,                   -- RL0306A
  construction_year      smallint,                   -- RL0307A
  construction_year_estimated boolean,               -- RL0307B (E = true, R = false)
  floor_area             numeric(8, 1),              -- RL0308A
  dwelling_count         integer,                    -- RL0311A
  market_reference_date  date NOT NULL,              -- RL0401A
  land_value             bigint,                     -- RL0402A
  building_value         bigint,                     -- RL0403A
  total_value            bigint NOT NULL,            -- RL0404A
  previous_total_value   bigint,                     -- RL0405A
  is_serviced_vacant_land boolean NOT NULL,          -- RL0501A
  non_residential_class  text,                       -- RL0502A
  raw                    jsonb NOT NULL,             -- full original unit, nothing lost
  import_run_id          bigint NOT NULL REFERENCES import_run (id),
  -- Safety net against duplicates: one matricule per municipality and roll year.
  UNIQUE (municipality_code, roll_year, matricule)
);

-- A unit can have several addresses (repeated group RL0101x).
CREATE TABLE property_address (
  id               bigserial PRIMARY KEY,
  property_unit_id bigint NOT NULL REFERENCES property_unit (id) ON DELETE CASCADE,
  position         smallint NOT NULL,      -- order in the file, starting at 1
  number_from      text,                   -- RL0101Ax
  number_from_suffix text,                 -- RL0101Bx
  number_to        text,                   -- RL0101Cx
  number_to_suffix text,                   -- RL0101Dx
  street_type_code text,                   -- RL0101Ex (e.g. CH = chemin)
  link_code        text,                   -- RL0101Fx
  street_name      text NOT NULL,          -- RL0101Gx
  direction        text,                   -- RL0101Hx (N, S, E, O...)
  apartment        text,                   -- RL0101Ix
  apartment_suffix text,                   -- RL0101Jx
  UNIQUE (property_unit_id, position)
);
