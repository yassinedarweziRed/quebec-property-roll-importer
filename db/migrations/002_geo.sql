-- Bonus: geolocation of property units (PostGIS).
-- Source: "Rôle géoréférencé" GeoPackage (one point per unit, whole province), loaded by `npm run geo`.

CREATE EXTENSION IF NOT EXISTS postgis;

-- 18-digit matricule used by the geo file: RL0104A+B+C+D+E+F without dashes, empty parts filled with zeros.
ALTER TABLE property_unit ADD COLUMN matricule18 char(18) NOT NULL;
CREATE INDEX property_unit_matricule18 ON property_unit (municipality_code, matricule18);

-- Kept separate from property_unit on purpose: the roll import and the geo import are independent.
-- Re-importing one never deletes the other; they are linked by (municipality_code, matricule18).
CREATE TABLE property_location (
  municipality_code     text NOT NULL,
  matricule18           char(18) NOT NULL,
  geom                  geometry(Point, 4326) NOT NULL,  -- WGS 84 (GPS), converted from NAD83
  location_quality_code smallint,   -- "rejet": 0 = well located, 2 = municipal limit, ... (domain CODE_DOM_REJET)
  source_file           text NOT NULL,
  PRIMARY KEY (municipality_code, matricule18)
);
CREATE INDEX property_location_geom ON property_location USING gist (geom);

-- Ready-to-use view: one row per unit with its point (NULL if no point found).
CREATE VIEW property_unit_map AS
SELECT p.id, p.municipality_code, p.roll_year, p.matricule, p.usage_code, p.construction_year,
       p.total_value, l.location_quality_code, l.geom
FROM property_unit p
LEFT JOIN property_location l USING (municipality_code, matricule18);
