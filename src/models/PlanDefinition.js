module.exports = (sequelize, DataTypes) => {
  const PlanDefinition = sequelize.define(
    'PlanDefinition',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      code: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      description: DataTypes.TEXT,
      billing_type: {
        type: DataTypes.ENUM('free', 'per_employee', 'flat', 'custom'),
        allowNull: false,
        defaultValue: 'per_employee',
      },
      monthly_price: {
        type: DataTypes.DECIMAL(12, 2),
        defaultValue: 0,
      },
      yearly_price: {
        type: DataTypes.DECIMAL(12, 2),
        defaultValue: 0,
      },
      price_per_employee: {
        type: DataTypes.DECIMAL(12, 2),
        defaultValue: 0,
      },
      trial_days: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      employee_limit: DataTypes.INTEGER,
      branch_limit: DataTypes.INTEGER,
      manager_limit: DataTypes.INTEGER,
      storage_limit_mb: DataTypes.INTEGER,
      attendance_retention_days: DataTypes.INTEGER,
      features: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      is_public: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      sort_order: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      metadata: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      tableName: 'plan_definitions',
      paranoid: true,
      underscored: true,
      indexes: [
        { fields: ['code'], unique: true },
        { fields: ['is_active', 'sort_order'] },
      ],
    }
  );

  PlanDefinition.associate = (models) => {
    PlanDefinition.hasMany(models.Organisation, {
      foreignKey: 'plan_definition_id',
      as: 'organisations',
    });
  };

  return PlanDefinition;
};
