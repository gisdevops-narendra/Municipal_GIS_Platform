-- Platform administrator flag (see User.isPlatformAdmin).
ALTER TABLE "users" ADD COLUMN "is_platform_admin" BOOLEAN NOT NULL DEFAULT false;
