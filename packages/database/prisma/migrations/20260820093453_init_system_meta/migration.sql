-- CreateTable
CREATE TABLE "system_meta" (
    "key" TEXT NOT NULL,
    "value" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_meta_pkey" PRIMARY KEY ("key")
);
