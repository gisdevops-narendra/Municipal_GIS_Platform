-- CreateTable
CREATE TABLE "modules" (
    "module_id" INTEGER NOT NULL,
    "module_name" TEXT NOT NULL,
    "isactive" BOOLEAN NOT NULL DEFAULT true,
    "module_parent_id" INTEGER,
    "node_path" TEXT,
    "sub_module" TEXT,
    "default_module" BOOLEAN,
    "display_priority" INTEGER,
    "type" TEXT,

    CONSTRAINT "modules_pkey" PRIMARY KEY ("module_id")
);

-- CreateTable
CREATE TABLE "department_module_grants" (
    "id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "module_id" INTEGER NOT NULL,
    "granted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_module_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_module_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "module_id" INTEGER NOT NULL,
    "granted_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_module_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "department_module_grants_department_id_module_id_key" ON "department_module_grants"("department_id", "module_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_module_grants_user_id_module_id_key" ON "user_module_grants"("user_id", "module_id");

-- AddForeignKey
ALTER TABLE "department_module_grants" ADD CONSTRAINT "department_module_grants_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_module_grants" ADD CONSTRAINT "department_module_grants_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("module_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_module_grants" ADD CONSTRAINT "user_module_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_module_grants" ADD CONSTRAINT "user_module_grants_module_id_fkey" FOREIGN KEY ("module_id") REFERENCES "modules"("module_id") ON DELETE CASCADE ON UPDATE CASCADE;
