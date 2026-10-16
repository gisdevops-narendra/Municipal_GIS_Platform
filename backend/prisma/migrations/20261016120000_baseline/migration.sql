-- Baseline: full schema as of 2026-10-16 (replaces the 14 earlier migrations)
-- plus the current Module Access catalog.


CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE TYPE public."DepartmentStatus" AS ENUM (
    'ACTIVE',
    'INACTIVE'
);

CREATE TYPE public."GisGeometryType" AS ENUM (
    'POINT',
    'LINE',
    'POLYGON'
);

CREATE TYPE public."GisLayerOwnershipType" AS ENUM (
    'CANONICAL',
    'DEPARTMENT'
);

CREATE TYPE public."GisLayerStatus" AS ENUM (
    'ACTIVE',
    'INACTIVE'
);

CREATE TYPE public."GisLayerType" AS ENUM (
    'VECTOR',
    'RASTER'
);

CREATE TYPE public."GisPermission" AS ENUM (
    'VIEW',
    'UPLOAD',
    'APPROVE',
    'PUBLISH',
    'EXPORT',
    'MANAGE'
);

CREATE TYPE public."GisUploadFileFormat" AS ENUM (
    'SHAPEFILE_ZIP',
    'GEOJSON',
    'CSV'
);

CREATE TYPE public."GisUploadStatus" AS ENUM (
    'UPLOAD_PENDING',
    'VALIDATING',
    'DRAFT',
    'IN_REVIEW',
    'APPROVED',
    'PUBLISHED',
    'REJECTED',
    'FAILED',
    'PUBLISH_FAILED'
);

CREATE TYPE public."GisWorkspaceStatus" AS ENUM (
    'PROVISIONING',
    'ACTIVE',
    'PROVISIONING_FAILED'
);

CREATE TYPE public."MunicipalityStatus" AS ENUM (
    'ACTIVE',
    'SUSPENDED'
);

CREATE TYPE public."SystemRole" AS ENUM (
    'MUNICIPALITY_OWNER',
    'DEPARTMENT_HEAD',
    'DEPARTMENT_USER'
);

CREATE TYPE public."UserStatus" AS ENUM (
    'ACTIVE',
    'DISABLED'
);

CREATE TABLE public.department_module_grants (
    id text NOT NULL,
    department_id text NOT NULL,
    module_id integer NOT NULL,
    granted_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.departments (
    id text NOT NULL,
    municipality_id text NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    description text,
    status public."DepartmentStatus" DEFAULT 'ACTIVE'::public."DepartmentStatus" NOT NULL,
    created_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.gis_demo_municipal_boundary (
    id integer NOT NULL,
    gis_workspace_id text NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    geom public.geometry(MultiPolygon,32643) NOT NULL
);

CREATE SEQUENCE public.gis_demo_municipal_boundary_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.gis_demo_municipal_boundary_id_seq OWNED BY public.gis_demo_municipal_boundary.id;

CREATE TABLE public.gis_demo_roads (
    id integer NOT NULL,
    gis_workspace_id text NOT NULL,
    name text NOT NULL,
    road_type text,
    status text DEFAULT 'Active'::text NOT NULL,
    geom public.geometry(MultiLineString,32643) NOT NULL
);

CREATE SEQUENCE public.gis_demo_roads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.gis_demo_roads_id_seq OWNED BY public.gis_demo_roads.id;

CREATE TABLE public.gis_demo_wards (
    id integer NOT NULL,
    gis_workspace_id text NOT NULL,
    name text NOT NULL,
    ward_number integer,
    geom public.geometry(MultiPolygon,32643) NOT NULL
);

CREATE SEQUENCE public.gis_demo_wards_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.gis_demo_wards_id_seq OWNED BY public.gis_demo_wards.id;

CREATE TABLE public.gis_layer_permissions (
    id text NOT NULL,
    gis_layer_id text NOT NULL,
    department_id text NOT NULL,
    role public."SystemRole" NOT NULL,
    permission public."GisPermission" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.gis_layer_uploads (
    id text NOT NULL,
    municipality_id text NOT NULL,
    gis_workspace_id text NOT NULL,
    uploaded_by text NOT NULL,
    original_filename text NOT NULL,
    stored_filename text NOT NULL,
    file_size integer NOT NULL,
    file_format public."GisUploadFileFormat" NOT NULL,
    status public."GisUploadStatus" DEFAULT 'UPLOAD_PENDING'::public."GisUploadStatus" NOT NULL,
    layer_name text NOT NULL,
    layer_code text NOT NULL,
    description text,
    department_id text,
    ownership_type public."GisLayerOwnershipType" DEFAULT 'DEPARTMENT'::public."GisLayerOwnershipType" NOT NULL,
    source_crs text,
    target_crs text,
    geometry_type public."GisGeometryType",
    feature_count integer,
    postgis_table text,
    validation_summary jsonb,
    error_message text,
    reviewed_by text,
    reviewed_at timestamp(3) without time zone,
    rejection_reason text,
    published_by text,
    published_at timestamp(3) without time zone,
    layer_id text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    style_spec jsonb
);

CREATE TABLE public.gis_layers (
    id text NOT NULL,
    gis_workspace_id text NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    description text,
    layer_type public."GisLayerType" DEFAULT 'VECTOR'::public."GisLayerType" NOT NULL,
    geoserver_workspace text NOT NULL,
    geoserver_layer text NOT NULL,
    geometry_type public."GisGeometryType",
    visible_by_default boolean DEFAULT true NOT NULL,
    status public."GisLayerStatus" DEFAULT 'ACTIVE'::public."GisLayerStatus" NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    bbox_min_x double precision,
    bbox_min_y double precision,
    bbox_max_x double precision,
    bbox_max_y double precision,
    created_by text,
    updated_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    department_id text,
    ownership_type public."GisLayerOwnershipType" DEFAULT 'CANONICAL'::public."GisLayerOwnershipType" NOT NULL,
    postgis_table text,
    source_upload_id text,
    version integer DEFAULT 1 NOT NULL,
    style_name text,
    style_spec jsonb
);

CREATE TABLE public.gis_workspaces (
    id text NOT NULL,
    municipality_id text NOT NULL,
    name text NOT NULL,
    code text NOT NULL,
    description text,
    status public."GisWorkspaceStatus" DEFAULT 'PROVISIONING'::public."GisWorkspaceStatus" NOT NULL,
    default_crs text DEFAULT 'EPSG:32643'::text NOT NULL,
    display_crs text DEFAULT 'EPSG:4326'::text NOT NULL,
    geoserver_workspace text NOT NULL,
    created_by text,
    updated_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.modules (
    module_id integer NOT NULL,
    module_name text NOT NULL,
    isactive boolean DEFAULT true NOT NULL,
    module_parent_id integer,
    node_path text,
    sub_module text,
    default_module boolean,
    display_priority integer,
    type text
);

CREATE SEQUENCE public.modules_module_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.modules_module_id_seq OWNED BY public.modules.module_id;

CREATE TABLE public.municipalities (
    id text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    state text NOT NULL,
    district text NOT NULL,
    city text NOT NULL,
    official_email text NOT NULL,
    contact_number text NOT NULL,
    status public."MunicipalityStatus" DEFAULT 'ACTIVE'::public."MunicipalityStatus" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.rag_documents (
    id text DEFAULT (gen_random_uuid())::text NOT NULL,
    municipality_id text,
    doc_type text NOT NULL,
    ref_key text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    embedding public.vector(384) NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.user_module_grants (
    id text NOT NULL,
    user_id text NOT NULL,
    module_id integer NOT NULL,
    granted_by text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);

CREATE TABLE public.user_settings (
    id text NOT NULL,
    user_id text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL
);

CREATE TABLE public.users (
    id text NOT NULL,
    keycloak_user_id text NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    mobile_number text NOT NULL,
    municipality_id text NOT NULL,
    system_role public."SystemRole" DEFAULT 'MUNICIPALITY_OWNER'::public."SystemRole" NOT NULL,
    status public."UserStatus" DEFAULT 'ACTIVE'::public."UserStatus" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone NOT NULL,
    created_by text,
    department_id text
);

ALTER TABLE ONLY public.gis_demo_municipal_boundary ALTER COLUMN id SET DEFAULT nextval('public.gis_demo_municipal_boundary_id_seq'::regclass);

ALTER TABLE ONLY public.gis_demo_roads ALTER COLUMN id SET DEFAULT nextval('public.gis_demo_roads_id_seq'::regclass);

ALTER TABLE ONLY public.gis_demo_wards ALTER COLUMN id SET DEFAULT nextval('public.gis_demo_wards_id_seq'::regclass);

ALTER TABLE ONLY public.modules ALTER COLUMN module_id SET DEFAULT nextval('public.modules_module_id_seq'::regclass);

ALTER TABLE ONLY public.department_module_grants
    ADD CONSTRAINT department_module_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gis_demo_municipal_boundary
    ADD CONSTRAINT gis_demo_municipal_boundary_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gis_demo_roads
    ADD CONSTRAINT gis_demo_roads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gis_demo_wards
    ADD CONSTRAINT gis_demo_wards_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gis_layer_permissions
    ADD CONSTRAINT gis_layer_permissions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gis_layer_uploads
    ADD CONSTRAINT gis_layer_uploads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gis_layers
    ADD CONSTRAINT gis_layers_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.gis_workspaces
    ADD CONSTRAINT gis_workspaces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.modules
    ADD CONSTRAINT modules_pkey PRIMARY KEY (module_id);

ALTER TABLE ONLY public.municipalities
    ADD CONSTRAINT municipalities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.rag_documents
    ADD CONSTRAINT rag_documents_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_module_grants
    ADD CONSTRAINT user_module_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX department_module_grants_department_id_module_id_key ON public.department_module_grants USING btree (department_id, module_id);

CREATE UNIQUE INDEX departments_municipality_id_code_key ON public.departments USING btree (municipality_id, code);

CREATE UNIQUE INDEX departments_municipality_id_name_key ON public.departments USING btree (municipality_id, name);

CREATE INDEX gis_demo_municipal_boundary_geom_idx ON public.gis_demo_municipal_boundary USING gist (geom);

CREATE INDEX gis_demo_municipal_boundary_workspace_idx ON public.gis_demo_municipal_boundary USING btree (gis_workspace_id);

CREATE INDEX gis_demo_roads_geom_idx ON public.gis_demo_roads USING gist (geom);

CREATE INDEX gis_demo_roads_workspace_idx ON public.gis_demo_roads USING btree (gis_workspace_id);

CREATE INDEX gis_demo_wards_geom_idx ON public.gis_demo_wards USING gist (geom);

CREATE INDEX gis_demo_wards_workspace_idx ON public.gis_demo_wards USING btree (gis_workspace_id);

CREATE INDEX gis_layer_permissions_department_id_idx ON public.gis_layer_permissions USING btree (department_id);

CREATE UNIQUE INDEX gis_layer_permissions_gis_layer_id_department_id_role_permi_key ON public.gis_layer_permissions USING btree (gis_layer_id, department_id, role, permission);

CREATE INDEX gis_layer_uploads_department_id_idx ON public.gis_layer_uploads USING btree (department_id);

CREATE INDEX gis_layer_uploads_municipality_id_status_idx ON public.gis_layer_uploads USING btree (municipality_id, status);

CREATE INDEX gis_layers_department_id_idx ON public.gis_layers USING btree (department_id);

CREATE UNIQUE INDEX gis_layers_gis_workspace_id_code_key ON public.gis_layers USING btree (gis_workspace_id, code);

CREATE UNIQUE INDEX gis_workspaces_geoserver_workspace_key ON public.gis_workspaces USING btree (geoserver_workspace);

CREATE UNIQUE INDEX gis_workspaces_municipality_id_key ON public.gis_workspaces USING btree (municipality_id);

CREATE UNIQUE INDEX municipalities_official_email_key ON public.municipalities USING btree (official_email);

CREATE INDEX rag_documents_embedding_idx ON public.rag_documents USING hnsw (embedding public.vector_cosine_ops);

CREATE UNIQUE INDEX rag_documents_ref_key ON public.rag_documents USING btree (municipality_id, ref_key) NULLS NOT DISTINCT;

CREATE INDEX rag_documents_scope_idx ON public.rag_documents USING btree (municipality_id, doc_type);

CREATE UNIQUE INDEX user_module_grants_user_id_module_id_key ON public.user_module_grants USING btree (user_id, module_id);

CREATE UNIQUE INDEX user_settings_user_id_key ON public.user_settings USING btree (user_id);

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);

CREATE UNIQUE INDEX users_keycloak_user_id_key ON public.users USING btree (keycloak_user_id);

ALTER TABLE ONLY public.department_module_grants
    ADD CONSTRAINT department_module_grants_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.department_module_grants
    ADD CONSTRAINT department_module_grants_module_id_fkey FOREIGN KEY (module_id) REFERENCES public.modules(module_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.gis_demo_municipal_boundary
    ADD CONSTRAINT gis_demo_municipal_boundary_gis_workspace_id_fkey FOREIGN KEY (gis_workspace_id) REFERENCES public.gis_workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.gis_demo_roads
    ADD CONSTRAINT gis_demo_roads_gis_workspace_id_fkey FOREIGN KEY (gis_workspace_id) REFERENCES public.gis_workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.gis_demo_wards
    ADD CONSTRAINT gis_demo_wards_gis_workspace_id_fkey FOREIGN KEY (gis_workspace_id) REFERENCES public.gis_workspaces(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.gis_layer_permissions
    ADD CONSTRAINT gis_layer_permissions_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.gis_layer_permissions
    ADD CONSTRAINT gis_layer_permissions_gis_layer_id_fkey FOREIGN KEY (gis_layer_id) REFERENCES public.gis_layers(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.gis_layer_uploads
    ADD CONSTRAINT gis_layer_uploads_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.gis_layer_uploads
    ADD CONSTRAINT gis_layer_uploads_gis_workspace_id_fkey FOREIGN KEY (gis_workspace_id) REFERENCES public.gis_workspaces(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.gis_layer_uploads
    ADD CONSTRAINT gis_layer_uploads_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES public.gis_layers(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.gis_layer_uploads
    ADD CONSTRAINT gis_layer_uploads_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.gis_layers
    ADD CONSTRAINT gis_layers_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.gis_layers
    ADD CONSTRAINT gis_layers_gis_workspace_id_fkey FOREIGN KEY (gis_workspace_id) REFERENCES public.gis_workspaces(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.gis_workspaces
    ADD CONSTRAINT gis_workspaces_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id) ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE ONLY public.rag_documents
    ADD CONSTRAINT rag_documents_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.user_module_grants
    ADD CONSTRAINT user_module_grants_module_id_fkey FOREIGN KEY (module_id) REFERENCES public.modules(module_id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.user_module_grants
    ADD CONSTRAINT user_module_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.user_settings
    ADD CONSTRAINT user_settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_department_id_fkey FOREIGN KEY (department_id) REFERENCES public.departments(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_municipality_id_fkey FOREIGN KEY (municipality_id) REFERENCES public.municipalities(id) ON UPDATE CASCADE ON DELETE RESTRICT;



-- Module Access catalog
INSERT INTO public.modules VALUES (1, 'Layers', true, NULL, '1', NULL, true, 1, 'mainleft');
INSERT INTO public.modules VALUES (910, 'Raster Data', true, 69, '69.910', NULL, false, 1, 'mainleft');
INSERT INTO public.modules VALUES (920, 'Terrain Analysis', true, 69, '69.920', NULL, false, 2, 'mainleft');
INSERT INTO public.modules VALUES (940, 'Raster Analytics', true, 69, '69.940', NULL, false, 3, 'mainleft');
INSERT INTO public.modules VALUES (950, 'Imagery Analysis', true, 69, '69.950', NULL, false, 4, 'mainleft');
INSERT INTO public.modules VALUES (911, 'Raster Upload & Publish', true, 910, '69.910.911', NULL, false, 1, 'mainleft');
INSERT INTO public.modules VALUES (912, 'Raster Styling', true, 910, '69.910.912', NULL, false, 2, 'mainleft');
INSERT INTO public.modules VALUES (913, 'Pixel Identify', true, 910, '69.910.913', NULL, false, 3, 'mainleft');
INSERT INTO public.modules VALUES (921, 'Elevation Profile', true, 920, '69.920.921', NULL, false, 1, 'mainleft');
INSERT INTO public.modules VALUES (922, 'Slope', true, 920, '69.920.922', NULL, false, 2, 'mainleft');
INSERT INTO public.modules VALUES (923, 'Aspect', true, 920, '69.920.923', NULL, false, 3, 'mainleft');
INSERT INTO public.modules VALUES (924, 'Hillshade', true, 920, '69.920.924', NULL, false, 4, 'mainleft');
INSERT INTO public.modules VALUES (925, 'Contour Generation', true, 920, '69.920.925', NULL, false, 5, 'mainleft');
INSERT INTO public.modules VALUES (926, 'Cut & Fill / Volume', true, 920, '69.920.926', NULL, false, 6, 'mainleft');
INSERT INTO public.modules VALUES (927, 'Drainage / Watershed', true, 920, '69.920.927', NULL, false, 7, 'mainleft');
INSERT INTO public.modules VALUES (928, 'Flood Inundation', true, 920, '69.920.928', NULL, false, 8, 'mainleft');
INSERT INTO public.modules VALUES (929, 'Line of Sight', true, 920, '69.920.929', NULL, false, 9, 'mainleft');
INSERT INTO public.modules VALUES (930, 'Viewshed', true, 920, '69.920.930', NULL, false, 10, 'mainleft');
INSERT INTO public.modules VALUES (941, 'Zonal Statistics', true, 940, '69.940.941', NULL, false, 1, 'mainleft');
INSERT INTO public.modules VALUES (942, 'Raster Calculator', true, 940, '69.940.942', NULL, false, 2, 'mainleft');
INSERT INTO public.modules VALUES (943, 'Reclassify', true, 940, '69.940.943', NULL, false, 3, 'mainleft');
INSERT INTO public.modules VALUES (944, 'Clip to Boundary', true, 940, '69.940.944', NULL, false, 4, 'mainleft');
INSERT INTO public.modules VALUES (945, 'Raster to Vector', true, 940, '69.940.945', NULL, false, 5, 'mainleft');
INSERT INTO public.modules VALUES (951, 'Swipe / Compare', true, 950, '69.950.951', NULL, false, 1, 'mainleft');
INSERT INTO public.modules VALUES (952, 'NDVI / Vegetation Index', true, 950, '69.950.952', NULL, false, 2, 'mainleft');
INSERT INTO public.modules VALUES (953, 'Change Detection', true, 950, '69.950.953', NULL, false, 3, 'mainleft');
INSERT INTO public.modules VALUES (901, 'Layer Styling', true, 1, '1.901', NULL, false, 1, 'mainleft');
INSERT INTO public.modules VALUES (15, 'Attribute Table', true, NULL, '15', NULL, true, 2, 'bottomhorizontal');
INSERT INTO public.modules VALUES (900, 'AI Assistant', true, NULL, '900', NULL, false, 3, 'mainleft');
INSERT INTO public.modules VALUES (4, 'Bookmark', true, NULL, '4', NULL, NULL, 4, 'mainleft');
INSERT INTO public.modules VALUES (2, 'Query Module', true, NULL, '2', NULL, NULL, 5, 'mainleft');
INSERT INTO public.modules VALUES (50, 'Attribute Query', true, 2, '2.50', NULL, NULL, 1, 'mainleft');
INSERT INTO public.modules VALUES (16, 'Spatial Query', true, 2, '2.16', NULL, NULL, 2, 'mainleft');
INSERT INTO public.modules VALUES (6, 'Buffer', true, 2, '2.6', NULL, NULL, 3, 'mainleft');
INSERT INTO public.modules VALUES (187, 'MultiBuffer', true, 6, '2.6.187', NULL, NULL, 1, 'mainleft');
INSERT INTO public.modules VALUES (11, 'Measure', true, NULL, '11', NULL, true, 6, 'mainleft');
INSERT INTO public.modules VALUES (73, 'Marking Tool', true, NULL, '73', NULL, NULL, 7, 'mainleft');
INSERT INTO public.modules VALUES (186, 'Analytics', true, NULL, '186', NULL, NULL, 8, 'bottomhorizontal');
INSERT INTO public.modules VALUES (229, 'Data Visualisation', true, 186, '186.229', NULL, NULL, 1, 'bottomhorizontal');
INSERT INTO public.modules VALUES (3, 'Print', true, NULL, '3', NULL, true, 9, 'mainleft');
INSERT INTO public.modules VALUES (251, 'Report Generation', true, NULL, '251', NULL, NULL, 10, 'bottomhorizontal');
INSERT INTO public.modules VALUES (226, 'Export Data', true, NULL, '226', NULL, NULL, 11, 'mainleft');
INSERT INTO public.modules VALUES (227, 'Export to csv', true, 226, '226.227', NULL, NULL, 1, 'mainleft');
INSERT INTO public.modules VALUES (228, 'Export to shapefile', true, 226, '226.228', NULL, NULL, 2, 'mainleft');
INSERT INTO public.modules VALUES (230, 'Export to kml', true, 226, '226.230', NULL, NULL, 3, 'mainleft');
INSERT INTO public.modules VALUES (18, 'Map Tools', true, NULL, '18', NULL, true, 12, 'mainright');
INSERT INTO public.modules VALUES (19, 'Zoom In', true, 18, '18.19', NULL, true, 1, 'mainright');
INSERT INTO public.modules VALUES (20, 'Zoom Out', true, 18, '18.20', NULL, true, 2, 'mainright');
INSERT INTO public.modules VALUES (21, 'Pan', true, 18, '18.21', NULL, true, 3, 'mainright');
INSERT INTO public.modules VALUES (59, 'Nav History', true, 18, '18.59', NULL, NULL, 4, 'mainright');
INSERT INTO public.modules VALUES (12, 'Go To X:Y', true, 18, '18.12', NULL, NULL, 5, 'mainright');
INSERT INTO public.modules VALUES (58, 'Information Tool', true, 18, '18.58', NULL, true, 6, 'mainright');
INSERT INTO public.modules VALUES (57, 'Selection Tool', true, 18, '18.57', NULL, true, 7, 'mainright');
INSERT INTO public.modules VALUES (17, 'Basemap', true, 18, '18.17', NULL, true, 8, 'mainright');
INSERT INTO public.modules VALUES (30, 'Free Search', true, 18, '18.30', NULL, true, 9, 'mainright');
INSERT INTO public.modules VALUES (5, 'Advanced Tools', true, NULL, '5', NULL, NULL, 20, 'mainleft');
INSERT INTO public.modules VALUES (13, 'Network Tracing', true, 5, '5.13', NULL, NULL, 1, 'mainleft');
INSERT INTO public.modules VALUES (7, 'Routing', true, 5, '5.7', NULL, NULL, 2, 'mainleft');
INSERT INTO public.modules VALUES (8, 'Basic Routing', true, 7, '5.7.8', NULL, NULL, 1, 'mainleft');
INSERT INTO public.modules VALUES (10, 'Nearest Facility', true, 7, '5.7.10', NULL, NULL, 2, 'mainleft');
INSERT INTO public.modules VALUES (69, 'Raster Analysis', true, NULL, '69', NULL, NULL, 21, 'mainleft');
INSERT INTO public.modules VALUES (14, 'Dashboard', true, NULL, '14', NULL, NULL, 22, 'mainleft');
INSERT INTO public.modules VALUES (55, 'Edit Panel', true, NULL, '55', NULL, NULL, 23, 'mainleft');
INSERT INTO public.modules VALUES (67, 'Time Series', true, NULL, '67', NULL, NULL, 24, 'mainleft');
INSERT INTO public.modules VALUES (74, '3D Button', true, NULL, '74', NULL, NULL, 25, 'mainleft');
INSERT INTO public.modules VALUES (221, 'Lidar View', true, NULL, '221', NULL, NULL, 26, 'mainleft');
INSERT INTO public.modules VALUES (185, 'Activity Log', true, NULL, '185', NULL, NULL, 27, 'mainleft');
SELECT pg_catalog.setval('public.modules_module_id_seq', 954, false);
